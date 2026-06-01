import { ExchangeClient } from "./exchanges";
import type { Candle } from "./types";

type MomentumFilter = "all" | "long" | "short" | "strongest";
type Direction = "LONG" | "SHORT";
type EntryType = "MARKET ENTRY" | "LIMIT ENTRY";

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
  { timeframe: "5m" as const, interval: "5", bars: 1, levels: [3, 5, 8] },
  { timeframe: "15m" as const, interval: "15", bars: 1, levels: [5, 10] },
  { timeframe: "1h" as const, interval: "60", bars: 1, levels: [8, 15] }
];

const alertCooldown = new Map<string, number>();

export class MomentumScanner {
  constructor(private client = new ExchangeClient()) {}

  async scan(filter: MomentumFilter = "all", limit = 8): Promise<MomentumMove[]> {
    const [linear, spot, btcCandles] = await Promise.all([
      this.client.bybitTickers("linear"),
      this.client.bybitTickers("spot").catch(() => [] as Ticker[]),
      this.client.bybitKlines("BTCUSDT", "5", "linear", 8).catch(() => [] as Candle[])
    ]);
    const spotBySymbol = new Map(spot.map((item) => [item.symbol, item]));
    const btcMove5m = pctMove(btcCandles, 1);
    const candidates = linear
      .filter((item) => item.symbol.endsWith("USDT") && item.lastPrice > 0 && item.turnover24h >= 1_000_000)
      .map((item) => ({ item, spot: spotBySymbol.get(item.symbol), rank: candidateRank(item, spotBySymbol.get(item.symbol)) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6);

    const rows = (await Promise.all(candidates.map(({ item, spot }) => this.analyze(item, spot, btcMove5m).catch(() => null))))
      .filter((row): row is MomentumMove => Boolean(row));
    return rows
      .filter((row) => filter === "all" || filter === "strongest" || filter === "long" && row.direction === "LONG" || filter === "short" && row.direction === "SHORT")
      .sort((a, b) => b.score - a.score || Math.abs(b.movePct) - Math.abs(a.movePct))
      .slice(0, limit);
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

  shouldSendAlert(move: MomentumMove, cooldownMinutes = 45) {
    const level = Math.floor(Math.abs(move.movePct));
    const key = `${move.symbol}:${move.direction}:${move.timeframe}:${level}`;
    const prev = alertCooldown.get(key) ?? 0;
    if (Date.now() - prev < cooldownMinutes * 60_000) return false;
    alertCooldown.set(key, Date.now());
    return true;
  }

  private async analyze(ticker: Ticker, spotTicker: Ticker | undefined, btcMove5m: number, force = false): Promise<MomentumMove | null> {
    const spreadPct = spread(ticker);
    if (!force && (ticker.turnover24h < 3_000_000 || spreadPct > 0.006)) return null;
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
    const spotConfirm = spot5.length ? Math.sign(pctMove(spot5, 1)) === Math.sign(trigger.movePct) && volumeSpikeRatio(spot5) >= 1.15 : Boolean(spotTicker && Math.sign(spotTicker.price24hPcnt) === Math.sign(trigger.movePct));
    const whaleScore = whaleScoreFor(direction, oiChange, orderBook.imbalance, accountRatio, spotConfirm, volumeSpike);
    const fake = fakeMoveRisk(direction, trigger.candles, volumeSpike, orderBook, spotConfirm, btcMove5m);
    const oiLabel = oiRead(direction, oiChange);
    const score = scoreMove(trigger.movePct, volumeSpike, oiChange, whaleScore, ticker.turnover24h, fake.risk);
    if (!force && (volumeSpike < 1.75 || fake.risk || score < 68)) return null;
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
    move.momentum,
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
