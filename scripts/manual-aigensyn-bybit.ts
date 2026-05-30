import { ExchangeClient } from "../src/local/exchanges";
import { atr, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "../src/local/indicators";
import { analyzeSmc } from "../src/local/smc";
import { btcStable, regimeFrom } from "../src/local/scoring";
import { TelegramNotifier } from "../src/local/telegram";
import type { Candle, MarketRegime } from "../src/local/types";

const client = new ExchangeClient();
const notifier = new TelegramNotifier();
const symbol = "AIGENSYNUSDT";
const tfs = ["5", "15", "60"];
const watchMode = process.env.WATCH_AIGENSYN === "1";
const watchIntervalMs = 60_000;

async function main() {
  let activationSent = false;
  while (true) {
    const result = await analyzeAndSend(!watchMode || !activationSent);
    if (result.qualified) activationSent = true;
    if (!watchMode || activationSent) return;
    await sleep(watchIntervalMs);
  }
}

async function analyzeAndSend(sendWatchlist: boolean) {
  const valid = await client.bybitInstrumentSymbols("linear");
  if (!valid.has(symbol)) {
    const message = `❌ НЕ ВХОДИТИ — ${symbol}\n\nПричина:\n• Bybit Futures не має активного linear perpetual для ${symbol}`;
    await notifier.send(message);
    console.log(message);
    return { qualified: false, score: 0 };
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
  const direction = longScore.score >= shortScore.score ? 1 : -1;
  const selected = direction === 1 ? longScore : shortScore;
  const side = direction === 1 ? "LONG" : "SHORT";
  const levels = tradeLevels(last.close, a, sr, direction);
  const qualified = selected.score >= 85 && btcOk && !fakeBreakoutRisk.high && regime !== "MANIPULATION_RISK";
  const watchlist = !qualified && selected.score >= 80 && selected.score < 85;
  const title = qualified ? `🟢 SETUP ACTIVATED — ${symbol}` : watchlist ? `⚠️ WATCHLIST ONLY — ${symbol}` : `❌ НЕ ВХОДИТИ — ${symbol}`;
  const probability = selected.score;
  const message = [
    title,
    "",
    "Bybit Futures ONLY",
    `Плече: x3 ONLY`,
    `Поточна ціна: ${fmt(last.close)}`,
    `Зона входу: ${fmt(levels.entry[0])}–${fmt(levels.entry[1])}`,
    `Stop Loss: ${fmt(levels.stopLoss)}`,
    `TP1: ${fmt(levels.takeProfit[0])}`,
    `TP2: ${fmt(levels.takeProfit[1])}`,
    `TP3: ${fmt(levels.takeProfit[2])}`,
    `Confidence: ${selected.score}%`,
    `Win probability: ${probability}%`,
    `Risk/Reward: ${levels.riskReward}`,
    `Invalidation level: ${fmt(levels.stopLoss)}`,
    `Market regime: ${regimeUa(regime)}`,
    "",
    "Точні причини:",
    ...selected.reasons.map((reason) => `• ${reason}`),
    ...(watchlist ? ["• ⚠️ WATCHLIST ONLY: близько до порогу, але входити ще рано", "• Тригер активації: score >= 85 з підтвердженням momentum/SMC/volume/orderbook"] : []),
    ...(!qualified ? [`• Сетап не проходить production-поріг 85/100: ${selected.score}/100`] : []),
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
    `• Win probability = capped final score = ${probability}%`,
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

  if (qualified || sendWatchlist) await notifier.send(message);
  console.log(message);
  return { qualified, score: selected.score };
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
    regime: input.regime === "TRENDING" ? 8 : input.regime === "RANGING" ? -8 : input.regime === "VOLATILE" ? -10 : -18
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
  const map: Record<MarketRegime, string> = { TRENDING: "трендовий", RANGING: "боковий", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
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

main().catch(async (error) => {
  const message = [`❌ НЕ ВХОДИТИ — ${symbol}`, "", "Причина:", `• Помилка live Bybit Futures аналізу: ${error instanceof Error ? error.message : String(error)}`, "• Жоден інший символ не аналізувався"].join("\n");
  await notifier.send(message).catch(() => undefined);
  console.error(message);
  process.exit(1);
});
