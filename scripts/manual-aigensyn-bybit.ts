import { ExchangeClient } from "../src/local/exchanges";
import { atr, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "../src/local/indicators";
import { analyzeSmc } from "../src/local/smc";
import { btcStable, regimeFrom } from "../src/local/scoring";
import { calculatePositionSizing } from "../src/local/positionSizing";
import { addPriorityPair } from "../src/local/watchlistStore";
import { config } from "../src/local/config";
import type { Candle, MarketRegime, PositionSizing } from "../src/local/types";

const client = new ExchangeClient();
const symbol = (process.env.PAIR ?? process.argv[2] ?? "AIGENSYNUSDT").toUpperCase();
const tfs = ["5", "15", "60"];
const watchMode = process.env.WATCH_AIGENSYN === "1" || process.env.PRIORITY_WATCH === "1";
const watchIntervalMs = 12_000;

async function main() {
  addPriorityPair(symbol);
  console.log(`PRIORITY WATCHLIST: ${symbol} Bybit Futures, interval ${watchIntervalMs / 1000}s`);
  if (!watchMode) {
    await analyzeAndSend(true, false);
    return;
  }
  let watchlistTracked = false;
  let invalidated = false;
  let activationSent = false;
  while (true) {
    const result = await analyzeAndSend(false, true, watchlistTracked);
    if (result.watchlist) watchlistTracked = true;
    if (result.invalidated && watchlistTracked) {
      invalidated = true;
      return;
    }
    if (result.qualified && result.analysis) {
      activationSent = true;
      await monitorActivatedTrade(result.analysis);
      return;
    }
    if (invalidated || activationSent) return;
    await sleep(watchIntervalMs);
  }
}

async function analyzeAndSend(sendWatchlist: boolean, priorityMode: boolean, canInvalidate = false) {
  const valid = await client.bybitInstrumentSymbols("linear");
  if (!valid.has(symbol)) {
    const message = `❌ НЕ ВХОДИТИ — ${symbol}\n\nПричина:\n• Bybit Futures не має активного linear perpetual для ${symbol}`;
    console.log(message);
    return { qualified: false, watchlist: false, invalidated: true, score: 0 };
  }

  const [candles, btcCandles, orderBookImbalance, fundingRate, openInterestChange] = await Promise.all([
    loadBybitFutures(symbol),
    loadBybitFutures("BTCUSDT"),
    client.orderBookImbalance(symbol).catch(() => 0),
    client.fundingRate(symbol).catch(() => 0),
    client.openInterestChange(symbol).catch(() => 0)
  ]);

  const primary = candles["15"];
  const closes = primary.map((c) => c.close);
  const last = primary.at(-1)!;
  const a = atr(primary);
  const e20 = ema(closes, 20).at(-1) ?? last.close;
  const e50 = ema(closes, 50).at(-1) ?? last.close;
  const e200 = ema(closes, 200).at(-1) ?? e50;
  const vw = vwap(primary);
  const rs = rsi(closes);
  const m = macd(closes);
  const smc = analyzeSmc(primary);
  const sr = supportResistance(primary);
  const regime = regimeFrom(candles);
  const btcOk = btcStable(btcCandles);
  const volume = volumeProfileScore(primary);
  const volatilityPct = last.close > 0 ? a / last.close : 0;
  const mtfLong = mtfDirection(candles, 1);
  const mtfShort = mtfDirection(candles, -1);
  const fakeBreakoutRisk = fakeBreakout(primary);

  const longScore = scoreSide(1, { e20, e50, e200, last, vw, rs, m, smc, volume, orderBookImbalance, fundingRate, openInterestChange, btcOk, regime, volatilityPct, mtf: mtfLong, fakeBreakoutRisk });
  const shortScore = scoreSide(-1, { e20, e50, e200, last, vw, rs, m, smc, volume, orderBookImbalance, fundingRate, openInterestChange, btcOk, regime, volatilityPct, mtf: mtfShort, fakeBreakoutRisk });
  const direction: 1 | -1 = longScore.score >= shortScore.score ? 1 : -1;
  const selected = direction === 1 ? longScore : shortScore;
  const side: "LONG" | "SHORT" = direction === 1 ? "LONG" : "SHORT";
  const levels = tradeLevels(last.close, a, sr, direction);
  const confirmations = confirmationFlags(selected, btcOk, fakeBreakoutRisk.high);
  const qualified = selected.score >= 85 && confirmations.volume && confirmations.momentum && confirmations.smc && confirmations.orderbook && confirmations.btc && confirmations.breakout;
  const watchlist = !qualified && selected.score >= 80 && selected.score < 85;
  const invalidated = priorityMode && canInvalidate && selected.score < 80 && (!confirmations.momentum || !confirmations.volume || !confirmations.btc || !confirmations.breakout);
  const positionSizing = calculatePositionSizing({ symbol, mode: "futures", side, score: selected.score, entry: levels.entry, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit, marketRegime: regime, volatilityPct, momentumScore: selected.parts.momentum, volumeScore: selected.parts.volume, btcStable: btcOk, orderFlowScore: selected.parts.orderbook, sniperConfidence: selected.parts.smc });
  const leverage = positionSizing?.leverage ?? leverageFor(selected.score, volatilityPct);
  const activationMessage = qualified ? conciseTradeMessage(symbol, side, levels, leverage, positionSizing) : `INTERNAL ANALYSIS — ${symbol}`;
  const raw = [
    activationMessage,
    "",
    "Weighted scoring:",
    `• Trend = ${selected.parts.trend}`,
    `• Volume = ${selected.parts.volume}`,
    `• SMC = ${selected.parts.smc}`,
    `• Momentum = ${selected.parts.momentum}`,
    `• Funding = ${selected.parts.funding}`,
    `• OI = ${selected.parts.oi}`,
    `• BTC filter = ${selected.parts.btc}`,
    `• Order book = ${selected.parts.orderbook}`,
    `• MTF alignment = ${selected.parts.mtf}`,
    `• Volatility = ${selected.parts.volatility}`,
    `• Fake breakout = ${selected.parts.fakeBreakout}`,
    `• Market regime = ${selected.parts.regime}`,
    `• Total = ${selected.score}`,
    "",
    "Probability logic:",
    `• Confidence = final score = ${selected.score}%`,
    `• Win probability = capped final score = ${selected.score}%`,
    "• Стару формулу 48 + score * 0.48 прибрано, бо вона завищувала ймовірність",
    "",
    "Raw analysis:",
    `• SMC BOS: ${yes(smc.bos)}`,
    `• CHOCH: ${yes(smc.choch)}`,
    `• Liquidity sweep: ${yes(smc.sweep)}`,
    `• RSI: ${rs.toFixed(2)}`,
    `• MACD histogram: ${m.histogram.toFixed(8)}`,
    `• EMA20/50/200: ${fmt(e20)} / ${fmt(e50)} / ${fmt(e200)}`,
    `• VWAP: ${fmt(vw)}`,
    `• Momentum score: ${selected.parts.momentum}`,
    `• Volatility ATR%: ${(volatilityPct * 100).toFixed(2)}%`,
    `• Volume score: ${Math.round(volume)}`,
    `• Funding: ${(fundingRate * 100).toFixed(4)}%`,
    `• OI change: ${(openInterestChange * 100).toFixed(3)}%`,
    `• BTC filter: ${btcOk ? "стабільний" : "нестабільний"}`,
    `• Fake breakout risk: ${fakeBreakoutRisk.high ? "високий" : "низький"}`
  ].join("\n");

  console.log(raw);
  return { qualified, watchlist, invalidated, score: selected.score, analysis: { symbol, side, levels, leverage, btcOk, direction, score: selected.score, positionSizing } };
}

async function monitorActivatedTrade(analysis: ActiveAnalysis) {
  const sent = new Set<string>();
  while (true) {
    await sleep(watchIntervalMs);
    const [candles, btcCandles] = await Promise.all([client.bybitKlines(analysis.symbol, "5", "linear", 5).catch(() => []), loadBybitFutures("BTCUSDT").catch(() => ({ "60": [] as Candle[] }))]);
    const current = candles.at(-1)?.close;
    if (!current) continue;
    const btcOk = btcStable(btcCandles as Record<string, Candle[]>);
    const short = analysis.side === "SHORT";
    const hitSl = short ? current >= analysis.levels.stopLoss : current <= analysis.levels.stopLoss;
    const hitTp1 = short ? current <= analysis.levels.takeProfit[0] : current >= analysis.levels.takeProfit[0];
    const hitTp2 = short ? current <= analysis.levels.takeProfit[1] : current >= analysis.levels.takeProfit[1];
    const hitTp3 = short ? current <= analysis.levels.takeProfit[2] : current >= analysis.levels.takeProfit[2];
    const action = hitSl
      ? `🔴 ${analysis.symbol}\n\n❌ Stop loss triggered\nTRADE CLOSED`
      : hitTp3
        ? `🟢 ${analysis.symbol}\n\nTP3 HIT\n✅ Trade closed`
        : !btcOk
          ? `⚠️ ${analysis.symbol}\n\nBTC risk increased`
          : hitTp2
            ? `🟠 ${analysis.symbol}\n\nTP2 HIT\n✅ Trail by ATR`
            : hitTp1
              ? [`🟠 ${analysis.symbol}`, "", "TP1 TOUCHED", "⏳ Do not move on first wick", analysis.positionSizing?.breakevenActivationRule ?? "Wait for TP1 hold, candle close beyond TP1, or strong post-TP1 momentum.", `BE+ target after confirmation: ${fmt(analysis.positionSizing?.breakevenPlusPrice ?? (analysis.levels.entry[0] + analysis.levels.entry[1]) / 2)} (+fees protected)`].join("\n")
              : `🟢 ${analysis.symbol}\n\nENTRY OPENED`;
    if (sent.has(action)) continue;
    sent.add(action);
    console.log([action, "", `Ціна: ${fmt(current)}`].join("\n"));
    if (hitSl || hitTp3) return;
  }
}

async function loadBybitFutures(target: string) {
  const entries = await Promise.all(tfs.map(async (tf) => [tf, await client.bybitKlines(target, tf, "linear", 220)] as const));
  for (const [tf, data] of entries) {
    if (!Array.isArray(data) || data.length < 80) throw new Error(`Недостатньо live Bybit futures candles для ${target} ${tf}: ${data.length}`);
  }
  return Object.fromEntries(entries) as Record<string, Candle[]>;
}

function scoreSide(direction: 1 | -1, input: AnalysisInput) {
  const trend = direction === 1
    ? input.e20 > input.e50 && input.e50 > input.e200 && input.last.close > input.vw
    : input.e20 < input.e50 && input.e50 < input.e200 && input.last.close < input.vw;
  const macdOk = direction === 1 ? input.m.histogram > 0 : input.m.histogram < 0;
  const rsiOk = direction === 1 ? input.rs > 52 && input.rs < 72 : input.rs < 48 && input.rs > 28;
  const smcOk = input.smc.direction === direction && (input.smc.bos || input.smc.choch || input.smc.sweep || input.smc.score >= 40);
  const orderbookOk = input.orderBookImbalance * direction > 0.03;
  const fundingOk = Math.abs(input.fundingRate) < 0.0008;
  const oiOk = input.openInterestChange * direction > -0.002;
  const volatilityOk = input.volatilityPct < 0.025;
  const mtfOk = input.mtf >= 67;
  const parts = {
    trend: trend ? 18 : 0,
    momentum: (macdOk ? 16 : 0) + (rsiOk ? 14 : 0),
    smc: smcOk ? Math.min(18, Math.max(8, input.smc.score)) : 0,
    mtf: mtfOk ? 12 : Math.round(input.mtf * 0.08),
    volume: input.volume > 65 ? 10 : input.volume > 45 ? 5 : 0,
    orderbook: orderbookOk ? 8 : 0,
    funding: fundingOk ? 6 : 0,
    oi: oiOk ? 6 : 0,
    btc: input.btcOk ? 8 : -16,
    volatility: volatilityOk ? 6 : -12,
    fakeBreakout: input.fakeBreakoutRisk.high ? -20 : 4,
    regime: input.regime === "TRENDING" || input.regime === "BREAKOUT" ? 8 : input.regime === "SIDEWAYS" || input.regime === "RANGING" || input.regime === "LOW_VOLATILITY" ? -8 : input.regime === "HIGH_VOLATILITY" || input.regime === "VOLATILE" ? -10 : -18
  };
  const score = Math.round(Math.max(0, Math.min(100, Object.values(parts).reduce((sum, value) => sum + value, 0))));
  const reasons = [
    `${direction === 1 ? "LONG" : "SHORT"} score: ${score}/100`,
    trend ? "EMA20/50/200 + VWAP підтримують напрямок" : "EMA/VWAP не дають чистого трендового підтвердження",
    macdOk ? "MACD підтримує напрямок" : "MACD не підтверджує напрямок",
    rsiOk ? "RSI у робочій зоні імпульсу" : "RSI не в оптимальній зоні для входу",
    smcOk ? "SMC підтверджує напрямок через структуру/BOS/CHOCH/sweep" : "SMC не дає достатнього підтвердження",
    mtfOk ? "5m/15m/60m узгоджені" : `MTF слабкий: ${Math.round(input.mtf)}%`,
    input.volume > 65 ? "Обсяг вище профілю" : "Обсяг недостатньо сильний",
    orderbookOk ? "Дисбаланс стакана підтримує напрямок" : "Стакан не підтримує напрямок достатньо сильно",
    fundingOk ? "Funding не перегрітий" : "Funding перегрітий",
    oiOk ? "OI не конфліктує з напрямком" : "OI конфліктує з напрямком",
    input.btcOk ? "BTC фільтр стабільний" : "BTC фільтр нестабільний",
    input.fakeBreakoutRisk.high ? "Високий ризик fake breakout" : "Ризик fake breakout низький"
  ];
  return { score, parts, reasons };
}

function confirmationFlags(selected: ReturnType<typeof scoreSide>, btcOk: boolean, fakeBreakoutHigh: boolean) {
  return {
    volume: selected.parts.volume >= 10,
    momentum: selected.parts.momentum >= 30,
    smc: selected.parts.smc >= 8,
    orderbook: selected.parts.orderbook >= 8,
    btc: btcOk,
    breakout: !fakeBreakoutHigh
  };
}

function leverageFor(score: number, volatilityPct: number) {
  let leverage = score >= 95 ? 3 : 2;
  if (volatilityPct > 0.018) leverage = Math.min(leverage, 2);
  else if (volatilityPct > 0.012) leverage = Math.min(leverage, 3);
  return `x${leverage}`;
}

function conciseTradeMessage(symbol: string, side: "LONG" | "SHORT", levels: ReturnType<typeof tradeLevels>, leverage: string, sizing?: PositionSizing) {
  const icon = side === "SHORT" ? "🔴" : "🟢";
  return [
    `${icon} ${side} — ${symbol}`,
    "",
    "✅ ЗАХОДИТИ ЗАРАЗ",
    "",
    "📍 Вхід:",
    `${fmt(levels.entry[0])}–${fmt(levels.entry[1])}`,
    "",
    "🛑 SL:",
    fmt(levels.stopLoss),
    "",
    "🎯 TP1:",
    fmt(levels.takeProfit[0]),
    "",
    "🎯 TP2:",
    fmt(levels.takeProfit[1]),
    "",
    "🎯 TP3:",
    fmt(levels.takeProfit[2]),
    "",
    "⚡ Плече:",
    sizing?.leverage ?? leverage,
    "",
    "⚙️ Margin:",
    sizing?.marginMode ?? "ISOLATED",
    "",
    "💰 Баланс:",
    `${sizing?.balanceUsdt ?? config.USER_BALANCE_USDT} USDT`,
    "",
    "📦 Вхід:",
    sizing ? `${sizing.positionSizeUsdt} USDT` : "після підтвердження входу",
    "",
    "🟠 Беззбиток:",
    sizing ? `TP1 -> BE+ ${fmt(sizing.breakevenPlusPrice ?? 0)} (+fees protected)` : "TP1 -> BE+ (+fees protected)"
  ].join("\n");
}

function mtfDirection(candles: Record<string, Candle[]>, direction: 1 | -1) {
  const aligned = tfs.filter((tf) => {
    const closes = candles[tf].map((c) => c.close);
    const e20 = ema(closes, 20).at(-1) ?? 0;
    const e50 = ema(closes, 50).at(-1) ?? 0;
    return direction === 1 ? e20 > e50 : e20 < e50;
  }).length;
  return aligned / tfs.length * 100;
}

function fakeBreakout(candles: Candle[]) {
  const data = candles.slice(-81);
  const last = data.at(-1)!;
  const prior = data.slice(0, -1);
  const resistance = Math.max(...prior.map((c) => c.high));
  const support = Math.min(...prior.map((c) => c.low));
  return { high: last.high > resistance && last.close < resistance || last.low < support && last.close > support, support, resistance };
}

function tradeLevels(price: number, a: number, sr: { support: number; resistance: number }, direction: 1 | -1) {
  const entry: [number, number] = direction === 1 ? [price - a * 0.15, price + a * 0.1] : [price - a * 0.1, price + a * 0.15];
  const stopLoss = direction === 1 ? Math.max(sr.support, price - a * 1.7) : Math.min(sr.resistance, price + a * 1.7);
  const takeProfit: [number, number, number] = direction === 1 ? [price + a * 1.4, price + a * 2.4, price + a * 3.8] : [price - a * 1.4, price - a * 2.4, price - a * 3.8];
  const risk = Math.abs((entry[0] + entry[1]) / 2 - stopLoss);
  const reward = Math.abs(takeProfit[2] - (entry[0] + entry[1]) / 2);
  return { entry, stopLoss, takeProfit, riskReward: risk > 0 ? `1:${(reward / risk).toFixed(1)}` : "Немає даних" };
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toFixed(6);
}

function yes(value: boolean) {
  return value ? "так" : "ні";
}

function regimeUa(regime: MarketRegime) {
  const map: Record<MarketRegime, string> = { TRENDING: "трендовий", SIDEWAYS: "боковий", BREAKOUT: "breakout", REVERSAL: "reversal", HIGH_VOLATILITY: "висока волатильність", LOW_VOLATILITY: "низька волатильність", CHOPPY: "шумний", RANGING: "боковий", EXPANSION: "розширення", COMPRESSION: "стиснення", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AnalysisInput {
  e20: number;
  e50: number;
  e200: number;
  last: Candle;
  vw: number;
  rs: number;
  m: ReturnType<typeof macd>;
  smc: ReturnType<typeof analyzeSmc>;
  volume: number;
  orderBookImbalance: number;
  fundingRate: number;
  openInterestChange: number;
  btcOk: boolean;
  regime: MarketRegime;
  volatilityPct: number;
  mtf: number;
  fakeBreakoutRisk: { high: boolean; support: number; resistance: number };
}

interface ActiveAnalysis {
  symbol: string;
  side: "LONG" | "SHORT";
  direction: 1 | -1;
  score: number;
  leverage: string;
  positionSizing?: PositionSizing;
  btcOk: boolean;
  levels: ReturnType<typeof tradeLevels>;
}

main().catch(async (error) => {
  const message = [`❌ НЕ ВХОДИТИ — ${symbol}`, "", "Причина:", `• Помилка live Bybit Futures аналізу: ${error instanceof Error ? error.message : String(error)}`, "• Жоден інший символ не аналізувався"].join("\n");
  console.error(message);
  process.exit(1);
});
