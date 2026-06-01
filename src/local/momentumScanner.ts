import { ExchangeClient } from "./exchanges";
import { loadTelegramSettings, maxLeverageNumber } from "./telegramSettings";
import type { Candle } from "./types";

type MomentumFilter = "all" | "long" | "short" | "strongest";
type Direction = "LONG" | "SHORT";
type EntryType = "MARKET ENTRY" | "LIMIT ENTRY";
type SetupType = "Momentum breakout" | "Whale accumulation" | "Whale distribution" | "Sniper retest" | "Reversal squeeze";

type Ticker = { symbol: string; lastPrice: number; bid1Price: number; ask1Price: number; turnover24h: number; volume24h: number; price24hPcnt: number };

export type MomentumMove = {
  symbol: string;
  direction: Direction;
  timeframe: "5m" | "15m" | "1h";
  movePct: number;
  fromPrice: number;
  toPrice: number;
  turnover24h: number;
  volumeSpike: number;
  oiLabel: string;
  oiChange: number;
  whaleLabel: string;
  whaleScore: number;
  setupType: SetupType;
  momentum: "Strong" | "Very Strong" | "Extreme";
  entryType: EntryType;
  entryReason: string;
  retest: [number, number];
  potential: "MEDIUM" | "HIGH" | "VERY HIGH";
  risk: "Low" | "Medium" | "High";
  reasons: string[];
  score: number;
};

const MOVE_THRESHOLDS = [
  { timeframe: "5m" as const, interval: "5", bars: 1, levels: [0.8, 1.8, 3.5] },
  { timeframe: "15m" as const, interval: "15", bars: 1, levels: [2, 4, 7] },
  { timeframe: "1h" as const, interval: "60", bars: 1, levels: [4, 8, 12] }
];

const alertCooldown = new Map<string, { sentAt: number; score: number; movePct: number; setupType: SetupType }>();

export class MomentumScanner {
  private tickerHistory = new Map<string, Array<{ at: number; price: number; turnover24h: number }>>();

  constructor(private client = new ExchangeClient()) {}

  async scan(filter: MomentumFilter = "all", limit = 8): Promise<MomentumMove[]> {
    const [linear, spot, btcCandles] = await Promise.all([
      this.client.bybitTickers("linear"),
      this.client.bybitTickers("spot").catch(() => [] as Ticker[]),
      this.client.bybitKlines("BTCUSDT", "5", "linear", 8).catch(() => [] as Candle[])
    ]);
    const spotBySymbol = new Map(spot.map((item) => [item.symbol, item]));
    const btcMove5m = pctMove(btcCandles, 1);
    this.rememberTickers([...linear, ...spot]);
    const candidates = linear
      .filter((item) => item.symbol.endsWith("USDT") && item.lastPrice > 0 && item.turnover24h >= 1_000_000)
      .map((item) => ({ item, spot: spotBySymbol.get(item.symbol), rank: candidateRank(item, spotBySymbol.get(item.symbol)) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 4);

    const rows = (await Promise.all(candidates.map(({ item, spot }) => this.analyze(item, spot, btcMove5m).catch(() => null))))
      .filter((row): row is MomentumMove => Boolean(row));
    return rows
      .filter((row) => filter === "all" || filter === "strongest" || filter === "long" && row.direction === "LONG" || filter === "short" && row.direction === "SHORT")
      .sort((a, b) => b.score - a.score || Math.abs(b.movePct) - Math.abs(a.movePct))
      .slice(0, limit);
  }

  async scanAutoSignals(limit = 3): Promise<MomentumMove[]> {
    const [linear, spot, btcCandles] = await Promise.all([
      this.client.bybitTickers("linear"),
      this.client.bybitTickers("spot").catch(() => [] as Ticker[]),
      this.client.bybitKlines("BTCUSDT", "5", "linear", 8).catch(() => [] as Candle[])
    ]);
    this.rememberTickers([...linear, ...spot]);
    const spotBySymbol = new Map(spot.map((item) => [item.symbol, item]));
    const btcMove5m = pctMove(btcCandles, 1);
    const candidates = linear
      .filter((item) => item.symbol.endsWith("USDT") && item.lastPrice > 0 && item.turnover24h >= 750_000 && spread(item) <= 0.008)
      .map((item) => ({ item, spot: spotBySymbol.get(item.symbol), rank: autoCandidateRank(item, spotBySymbol.get(item.symbol), this.recentMovePct(item.symbol)) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 4);

    const rows = (await Promise.all(candidates.map(({ item, spot }) => this.analyze(item, spot, btcMove5m).catch(() => null))))
      .filter((row): row is MomentumMove => Boolean(row));
    return rows.sort((a, b) => b.score - a.score || Math.abs(b.movePct) - Math.abs(a.movePct)).slice(0, limit);
  }

  async checkSymbol(symbol: string): Promise<MomentumMove | null> {
    const pair = normalizeSymbol(symbol);
    const [linear, spot, btcCandles] = await Promise.all([
      this.client.bybitTickers("linear"),
      this.client.bybitTickers("spot").catch(() => [] as Ticker[]),
      this.client.bybitKlines("BTCUSDT", "5", "linear", 8).catch(() => [] as Candle[])
    ]);
    const ticker = linear.find((item) => item.symbol === pair);
    if (!ticker) return null;
    return this.analyze(ticker, spot.find((item) => item.symbol === pair), pctMove(btcCandles, 1), true).catch(() => null);
  }

  shouldSendAlert(move: MomentumMove, cooldownMinutes = 60) {
    const key = move.symbol;
    const prev = alertCooldown.get(key);
    if (prev) {
      const elapsed = Date.now() - prev.sentAt;
      const improved = move.score >= prev.score + 8 || Math.abs(move.movePct) >= Math.abs(prev.movePct) + 1.2 || move.setupType !== prev.setupType && move.score >= prev.score + 4;
      if (elapsed < cooldownMinutes * 60_000 && !improved) return false;
    }
    alertCooldown.set(key, { sentAt: Date.now(), score: move.score, movePct: move.movePct, setupType: move.setupType });
    return true;
  }

  cooldownProof(move: MomentumMove, cooldownMinutes = 60) {
    const first = this.shouldSendAlert(move, cooldownMinutes);
    const second = this.shouldSendAlert(move, cooldownMinutes);
    return { first, second, suppressed: first && !second };
  }

  private rememberTickers(tickers: Ticker[]) {
    const now = Date.now();
    for (const ticker of tickers) {
      if (!ticker.symbol.endsWith("USDT") || ticker.lastPrice <= 0) continue;
      const rows = [...(this.tickerHistory.get(ticker.symbol) ?? []), { at: now, price: ticker.lastPrice, turnover24h: ticker.turnover24h }]
        .filter((row) => now - row.at <= 10 * 60_000)
        .slice(-80);
      this.tickerHistory.set(ticker.symbol, rows);
    }
  }

  private recentMovePct(symbol: string) {
    const rows = this.tickerHistory.get(symbol) ?? [];
    const latest = rows.at(-1);
    if (!latest) return 0;
    const from = [...rows].reverse().find((row) => latest.at - row.at >= 4 * 60_000) ?? rows[0];
    return from?.price ? (latest.price - from.price) / from.price * 100 : 0;
  }

  private async analyze(ticker: Ticker, spotTicker: Ticker | undefined, btcMove5m: number, force = false): Promise<MomentumMove | null> {
    const spreadPct = spread(ticker);
    if (!force && (ticker.turnover24h < 750_000 || spreadPct > 0.008)) return null;
    const [candles5, candles15, candles60, spot5, oiChange, orderBook, accountRatio] = await Promise.all([
      this.client.bybitKlines(ticker.symbol, "5", "linear", 36),
      this.client.bybitKlines(ticker.symbol, "15", "linear", 24),
      this.client.bybitKlines(ticker.symbol, "60", "linear", 12),
      spotTicker ? this.client.bybitKlines(ticker.symbol, "5", "spot", 24).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
      this.client.openInterestChange(ticker.symbol).catch(() => 0),
      this.client.bybitOrderBookStats(ticker.symbol, "linear").catch(() => ({ spreadPct, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
      this.client.bybitAccountRatio(ticker.symbol).catch(() => 0)
    ]);
    const trigger = bestTrigger([{ config: MOVE_THRESHOLDS[0], candles: candles5 }, { config: MOVE_THRESHOLDS[1], candles: candles15 }, { config: MOVE_THRESHOLDS[2], candles: candles60 }]);
    if (!trigger) return null;
    const direction: Direction = trigger.movePct > 0 ? "LONG" : "SHORT";
    const volumeSpike = volumeSpikeRatio(trigger.candles);
    const spotConfirm = spot5.length ? Math.sign(pctMove(spot5, 1)) === Math.sign(trigger.movePct) && volumeSpikeRatio(spot5) >= 1.15 : spotTicker ? Math.sign(spotTicker.price24hPcnt) === Math.sign(trigger.movePct) : true;
    const whaleScore = whaleScoreFor(direction, oiChange, orderBook.imbalance, accountRatio, spotConfirm, volumeSpike);
    const fake = fakeMoveRisk(direction, trigger.candles, volumeSpike, orderBook, spotConfirm, btcMove5m);
    const oiLabel = oiRead(direction, oiChange);
    const score = scoreMove(trigger.movePct, volumeSpike, oiChange, whaleScore, ticker.turnover24h, fake.risk);
    if (!force && (volumeSpike < 1.45 || fake.risk || score < 62 || ticker.turnover24h < 1_000_000 && score < 78)) return null;
    const range = lastRange(trigger.candles);
    const retest = retestZone(direction, trigger.toPrice, range);
    const marketEntry = score >= 84 && volumeSpike >= 2.6 && whaleScore >= 70 && oiConfirms(direction, oiChange) && !extendedWickAgainst(direction, trigger.candles);
    return {
      symbol: ticker.symbol,
      direction,
      timeframe: trigger.config.timeframe,
      movePct: trigger.movePct,
      fromPrice: trigger.fromPrice,
      toPrice: trigger.toPrice,
      turnover24h: ticker.turnover24h,
      volumeSpike,
      oiLabel,
      oiChange,
      whaleLabel: whaleScore >= 72 ? `Accumulation ${Math.round(whaleScore)}%` : whaleScore <= 35 ? `Distribution ${Math.round(100 - whaleScore)}%` : `Neutral ${Math.round(whaleScore)}%`,
      whaleScore,
      setupType: setupTypeFor(direction, score, whaleScore, oiChange, volumeSpike, marketEntry, trigger.movePct),
      momentum: score >= 90 ? "Extreme" : score >= 80 ? "Very Strong" : "Strong",
      entryType: marketEntry ? "MARKET ENTRY" : "LIMIT ENTRY",
      entryReason: marketEntry ? "Breakout confirmed" : `Retest: ${fmt(retest[0])} - ${fmt(retest[1])}`,
      retest,
      potential: score >= 88 ? "VERY HIGH" : score >= 76 ? "HIGH" : "MEDIUM",
      risk: fake.warning || !oiConfirms(direction, oiChange) ? "High" : volumeSpike >= 2.4 && whaleScore >= 65 ? "Medium" : "Medium",
      reasons: reasonsFor(volumeSpike, oiLabel, whaleScore, spotConfirm, fake.reasons),
      score
    };
  }
}

export function formatAutoEntrySignal(move: MomentumMove) {
  const icon = move.direction === "LONG" ? "🟢" : "🔴";
  const plan = smallBalancePlan(move);
  return [
    "━━━━━━━━━━",
    "🚨 AUTO ENTRY SIGNAL",
    "",
    `🪙 COIN: ${move.symbol}`,
    "",
    "📍 НАПРЯМОК:",
    `${icon} ${move.direction}`,
    "",
    "✅ МОЖНА ВХОДИТИ",
    "",
    `🔥 Тип: ${move.setupType}`,
    `Confidence: ${move.score}%`,
    `Whale score: ${Math.round(move.whaleScore)}/100`,
    "",
    "📈 Що підтверджує:",
    `• Price ${signed(move.movePct)}% / ${move.timeframe}`,
    `• OI ${move.oiChange >= 0 ? "↑" : "↓"} ${(Math.abs(move.oiChange) * 100).toFixed(2)}%`,
    `• volume anomaly ${move.volumeSpike.toFixed(1)}x`,
    ...move.reasons.slice(0, 4).map((reason) => `• ${reason}`),
    "",
    "⚡ EXECUTION:",
    move.entryType === "MARKET ENTRY" ? "MARKET" : "LIMIT WAIT",
    "",
    `📍 Entry: ${fmt(plan.entryLow)}–${fmt(plan.entryHigh)}`,
    "",
    `🛑 SL: ${fmt(plan.stopLoss)}`,
    "",
    `🎯 TP1: ${fmt(plan.tp[0])} (+${formatAmount(plan.profits[0])} USDT profit)`,
    `🎯 TP2: ${fmt(plan.tp[1])} (+${formatAmount(plan.profits[1])} USDT profit)`,
    `🎯 TP3: ${fmt(plan.tp[2])} (+${formatAmount(plan.profits[2])} USDT profit)`,
    "",
    `💰 Small balance mode ($${formatAmount(plan.balance)}):`,
    `Qty: ${formatQty(plan.qty)} ${baseAsset(move.symbol)}`,
    `Position size: ${formatAmount(plan.positionSize)} USDT (${plan.leverage}x)`,
    `Risk USDT: ${formatAmount(plan.maxLoss)}`,
    `Potential profit USDT: ${plan.profits.map(formatAmount).join(" / ")}`,
    `Max loss: -${formatAmount(plan.maxLoss)} USDT`,
    `Liquidation safety: ${plan.liquidationSafety}`,
    "",
    `⚖️ RR: 1:${plan.rr.toFixed(1)}`,
    "━━━━━━━━━━"
  ].join("\n");
}

export function formatMomentumAlert(move: MomentumMove) {
  const icon = move.direction === "LONG" ? "🟢" : "🔴";
  return [
    `🚨 ВЕЛИКИЙ РУХ — ${move.symbol}`,
    "",
    `${icon} Рух: ${signed(move.movePct)}% за ${move.timeframe.replace("m", " хв").replace("1h", "1 год")}`,
    "",
    "💰 Ціна:",
    `${fmt(move.fromPrice)} → ${fmt(move.toPrice)}`,
    "",
    "📊 Обсяг 24h:",
    `${formatUsd(move.turnover24h)} USDT`,
    "",
    "📈 OI:",
    move.oiLabel,
    "",
    "🐋 Кити:",
    move.whaleLabel,
    "",
    "🔥 Momentum:",
    `${move.momentum} / ${move.setupType}`,
    "",
    "📍 Потенційний напрямок:",
    `${icon} ${move.direction}`,
    "",
    "⚡ ENTRY:",
    `${move.entryType === "MARKET ENTRY" ? "🟢" : "🟡"} ${move.entryType}`,
    move.entryReason,
    "",
    "🎯 Потенціал:",
    move.potential,
    "",
    "⚠️ Risk:",
    move.risk,
    "",
    "Причина:",
    ...move.reasons.slice(0, 6).map((reason) => `• ${reason}`)
  ].join("\n");
}

export function formatMomentumList(rows: MomentumMove[], title = "🚨 Великі рухи / Momentum Scanner") {
  if (!rows.length) return [title, "", "Сильних clean momentum moves зараз немає.", "Фільтр відсікає low liquidity, fake pumps, weak OI та BTC-conflict."].join("\n");
  return [title, "", ...rows.map(formatMomentumAlert)].join("\n\n");
}

export function momentumActionsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Оновити", callback_data: "ui:momentum" }],
      [{ text: "📈 LONG movers", callback_data: "ui:momentum_long" }, { text: "📉 SHORT movers", callback_data: "ui:momentum_short" }],
      [{ text: "🔥 Найсильніші рухи", callback_data: "ui:momentum_strongest" }, { text: "🔍 Перевірити монету", callback_data: "ui:momentum_check" }],
      [{ text: "🔙 Назад", callback_data: "ui:back" }]
    ]
  };
}

export type { MomentumFilter };

function candidateRank(item: Ticker, spot?: Ticker) {
  const liquidity = Math.log10(Math.max(item.turnover24h, 1));
  const move = Math.abs(item.price24hPcnt) * 100;
  const spotConfirm = spot ? Math.sign(spot.price24hPcnt) === Math.sign(item.price24hPcnt) ? 8 : -6 : 0;
  return move * 6 + liquidity * 8 + spotConfirm;
}

function autoCandidateRank(item: Ticker, spot: Ticker | undefined, recentMovePct: number) {
  const liquidity = Math.log10(Math.max(item.turnover24h, 1));
  const dayMove = Math.abs(item.price24hPcnt) * 100;
  const recentMove = Math.abs(recentMovePct);
  const newCoinBoost = item.turnover24h >= 750_000 && item.turnover24h < 5_000_000 && dayMove >= 6 ? 10 : 0;
  const spotConfirm = spot ? Math.sign(spot.price24hPcnt) === Math.sign(item.price24hPcnt || recentMovePct) ? 8 : -10 : -4;
  return recentMove * 20 + dayMove * 4 + liquidity * 8 + newCoinBoost + spotConfirm - spread(item) * 900;
}

function setupTypeFor(direction: Direction, score: number, whaleScore: number, oiChange: number, volumeSpike: number, marketEntry: boolean, movePct: number): SetupType {
  const whaleDirectional = direction === "LONG" ? whaleScore >= 72 : whaleScore <= 35;
  if (marketEntry && Math.abs(movePct) >= 2.5 && volumeSpike >= 2.2) return "Momentum breakout";
  if (whaleDirectional && Math.abs(oiChange) >= 0.004) return direction === "LONG" ? "Whale accumulation" : "Whale distribution";
  if (!marketEntry && score >= 72) return "Sniper retest";
  if (direction === "SHORT" && oiChange > 0.004 && volumeSpike >= 1.8) return "Reversal squeeze";
  return "Momentum breakout";
}

function smallBalancePlan(move: MomentumMove) {
  const settings = loadTelegramSettings();
  const balance = settings.balanceUsdt;
  const leverage = Math.min(maxLeverageNumber(), balance <= 10 ? 3 : 5);
  const margin = Math.min(balance * 0.9, balance <= 10 ? balance : balance * 0.5);
  const positionSize = margin * leverage;
  const market = move.entryType === "MARKET ENTRY";
  const entryLow = market ? move.toPrice * 0.999 : Math.min(move.retest[0], move.retest[1]);
  const entryHigh = market ? move.toPrice * 1.001 : Math.max(move.retest[0], move.retest[1]);
  const entry = (entryLow + entryHigh) / 2;
  const riskPct = move.direction === "LONG" ? 0.018 : 0.018;
  const rewardPct = Math.max(0.022, Math.min(0.09, Math.abs(move.movePct) / 100 * 1.15));
  const stopLoss = move.direction === "LONG" ? entry * (1 - riskPct) : entry * (1 + riskPct);
  const tp: [number, number, number] = move.direction === "LONG"
    ? [entry * (1 + rewardPct * 0.7), entry * (1 + rewardPct), entry * (1 + rewardPct * 1.6)]
    : [entry * (1 - rewardPct * 0.7), entry * (1 - rewardPct), entry * (1 - rewardPct * 1.6)];
  const qty = positionSize / entry;
  const maxLoss = Math.abs(entry - stopLoss) * qty;
  const profits = tp.map((target) => Math.abs(target - entry) * qty) as [number, number, number];
  const rr = profits[1] / Math.max(maxLoss, 0.0001);
  const liquidationSafetyPct = Math.max(0, 100 / leverage - riskPct * 100);
  return { balance, leverage, margin, positionSize, entryLow, entryHigh, stopLoss, tp, qty, maxLoss, profits, rr, liquidationSafety: liquidationSafetyPct >= 20 ? "OK" : liquidationSafetyPct >= 12 ? "MEDIUM" : "TIGHT" };
}

function bestTrigger(items: Array<{ config: typeof MOVE_THRESHOLDS[number]; candles: Candle[] }>) {
  return items.flatMap(({ config, candles }) => {
    const movePct = pctMove(candles, config.bars);
    const abs = Math.abs(movePct);
    const level = config.levels.filter((value) => abs >= value).at(-1);
    if (!level || candles.length <= config.bars) return [];
    const from = candles.at(-(config.bars + 1))!.close;
    const to = candles.at(-1)!.close;
    return [{ config, candles, movePct, fromPrice: from, toPrice: to, level }];
  }).sort((a, b) => b.level - a.level || Math.abs(b.movePct) - Math.abs(a.movePct))[0];
}

function pctMove(candles: Candle[], bars: number) {
  if (candles.length <= bars) return 0;
  const from = candles.at(-(bars + 1))?.close ?? 0;
  const to = candles.at(-1)?.close ?? 0;
  return from > 0 ? (to - from) / from * 100 : 0;
}

function volumeSpikeRatio(candles: Candle[]) {
  if (candles.length < 10) return 1;
  const current = quoteVolume(candles.at(-1)!);
  const avg = candles.slice(-13, -1).reduce((sum, candle) => sum + quoteVolume(candle), 0) / Math.min(12, candles.length - 1);
  return avg > 0 ? current / avg : 1;
}

function quoteVolume(candle: Candle) {
  return candle.volume * candle.close;
}

function oiRead(direction: Direction, oiChange: number) {
  const priceUp = direction === "LONG";
  if (priceUp && oiChange > 0.002) return "Price ↑ + OI ↑";
  if (priceUp && oiChange < -0.002) return "Price ↑ + OI ↓";
  if (!priceUp && oiChange > 0.002) return "Price ↓ + OI ↑";
  if (!priceUp && oiChange < -0.002) return "Price ↓ + OI ↓";
  return `${priceUp ? "Price ↑" : "Price ↓"} + OI neutral`;
}

function oiConfirms(direction: Direction, oiChange: number) {
  return direction === "LONG" ? oiChange > 0.0015 : oiChange > 0.0015 || oiChange < -0.004;
}

function whaleScoreFor(direction: Direction, oiChange: number, imbalance: number, accountRatio: number, spotConfirm: boolean, volumeSpike: number) {
  let score = 50;
  const sign = direction === "LONG" ? 1 : -1;
  score += sign * imbalance * 24;
  score += sign * accountRatio * 18;
  score += oiConfirms(direction, oiChange) ? 12 : -8;
  score += spotConfirm ? 10 : -12;
  score += Math.min(12, Math.max(0, volumeSpike - 1) * 4);
  return clamp(score, 0, 100);
}

function fakeMoveRisk(direction: Direction, candles: Candle[], volumeSpike: number, book: { spreadPct: number; depthUsdt: number; spoofRisk: boolean }, spotConfirm: boolean, btcMove5m: number) {
  const reasons: string[] = [];
  if (volumeSpike < 1.75) reasons.push("volume anomaly too weak");
  if (book.depthUsdt > 0 && book.depthUsdt < 20_000) reasons.push("low orderbook depth");
  if (book.spreadPct > 0.006) reasons.push("wide spread / low liquidity");
  if (book.spoofRisk) reasons.push("orderbook spoof risk");
  if (!spotConfirm) reasons.push("spot market does not confirm futures move");
  if (direction === "LONG" && btcMove5m <= -1.2) reasons.push("BTC dumping, fake LONG blocked");
  if (extendedWickAgainst(direction, candles)) reasons.push("rejection wick against direction");
  return { risk: reasons.length > 0, warning: reasons.length > 0, reasons };
}

function extendedWickAgainst(direction: Direction, candles: Candle[]) {
  const last = candles.at(-1);
  if (!last) return true;
  const range = Math.max(last.high - last.low, last.close * 0.0001);
  const upper = (last.high - Math.max(last.open, last.close)) / range;
  const lower = (Math.min(last.open, last.close) - last.low) / range;
  return direction === "LONG" ? upper > 0.45 : lower > 0.45;
}

function scoreMove(movePct: number, volumeSpike: number, oiChange: number, whaleScore: number, turnover24h: number, fake: boolean) {
  const moveScore = Math.min(30, Math.abs(movePct) * 3);
  const volumeScore = Math.min(25, volumeSpike * 8);
  const oiScore = Math.min(15, Math.abs(oiChange) * 2500);
  const liquidityScore = Math.min(10, Math.log10(Math.max(turnover24h, 1)));
  return Math.round(clamp(moveScore + volumeScore + oiScore + whaleScore * 0.25 + liquidityScore - (fake ? 28 : 0), 0, 100));
}

function lastRange(candles: Candle[]) {
  const last = candles.at(-1);
  return last ? Math.max(last.high - last.low, last.close * 0.001) : 0;
}

function retestZone(direction: Direction, price: number, range: number): [number, number] {
  if (direction === "LONG") return [price - range * 0.45, price - range * 0.25];
  return [price + range * 0.25, price + range * 0.45];
}

function reasonsFor(volumeSpike: number, oiLabel: string, whaleScore: number, spotConfirm: boolean, fakeReasons: string[]) {
  const reasons = [`volume spike ${volumeSpike.toFixed(1)}x`, oiLabel.includes("neutral") ? "OI neutral" : "OI confirmation"];
  if (whaleScore >= 65) reasons.push("whale accumulation");
  if (whaleScore <= 35) reasons.push("whale distribution");
  if (spotConfirm) reasons.push("spot confirms futures move");
  reasons.push("breakout structure");
  return [...reasons, ...fakeReasons.map((reason) => `risk checked: ${reason}`)];
}

function spread(ticker: Ticker) {
  return ticker.bid1Price > 0 && ticker.ask1Price > 0 ? (ticker.ask1Price - ticker.bid1Price) / ((ticker.ask1Price + ticker.bid1Price) / 2) : 1;
}

function normalizeSymbol(input: string) {
  const raw = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.endsWith("USDT") ? raw : `${raw}USDT`;
}

function fmt(value: number) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatUsd(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function formatAmount(value: number) {
  return value >= 10 ? value.toFixed(2) : value.toFixed(4);
}

function formatQty(value: number) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function baseAsset(symbol: string) {
  return symbol.replace(/USDT$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
