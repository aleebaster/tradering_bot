import { ExchangeClient } from "../src/local/exchanges";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import { isRealEntrySignal, TelegramNotifier } from "../src/local/telegram";
import type { Candle, ExchangeConfirmations, MarketSnapshot, Signal } from "../src/local/types";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";

const client = new ExchangeClient();
const notifier = new TelegramNotifier();
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const tfs = ["1", "5", "15", "60", "240"];
const bybitOnly = process.env.BYBIT_ONLY === "1";
const pumpDetector = new PumpDetectorBot();
const whaleTracker = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();

async function main() {
  let btcCandles: Record<string, Candle[]>;
  try {
    btcCandles = await loadBybit("BTCUSDT");
  } catch {
    console.log("INTERNAL TEST: Bybit BTCUSDT unavailable; no Telegram message sent.");
    return;
  }
  const btcOk = btcStable(btcCandles);
  const signals: Signal[] = [];
  for (const symbol of symbols) {
    let candles: Record<string, Candle[]>;
    try {
      candles = symbol === "BTCUSDT" ? btcCandles : await loadBybit(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Bybit ${symbol} failed; continuing safely: ${message}`);
      continue;
    }
    const [okx, kucoin, binance, orderBook, funding, oi] = await Promise.all([
      bybitOnly ? Promise.resolve(emptyCandles()) : loadOkx(symbol),
      bybitOnly ? Promise.resolve(emptyCandles()) : loadKucoin(symbol),
      bybitOnly ? Promise.resolve(emptyCandles()) : loadBinance(symbol),
      client.bybitOrderBookStats(symbol).catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
      client.fundingRate(symbol).catch(() => 0),
      client.openInterestChange(symbol).catch(() => 0)
    ]);
    const liquidityScore = liquidity(candles["15"]);
    const regime = regimeFrom(candles);
    const intelligenceInput = { symbol, candles, orderBook, fundingRate: funding, openInterestChange: oi, liquidityScore, btcStable: symbol === "BTCUSDT" ? true : btcOk, regime };
    const intelligence = {
      pump: pumpDetector.analyze(intelligenceInput),
      whale: whaleTracker.analyze(intelligenceInput),
      liq: liqBot.analyze(intelligenceInput),
      market: marketReportBot.analyze(intelligenceInput),
      updatedAt: new Date().toISOString()
    };
    const snapshot: MarketSnapshot = {
      symbol,
      mode: "futures",
      candles,
      okxCandles: okx,
      kucoinCandles: kucoin,
      binanceCandles: binance,
      orderBookImbalance: orderBook.imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore,
      whaleScore: intelligence.whale.smartMoneyScore,
      btcStable: symbol === "BTCUSDT" ? true : btcOk,
      regime,
      confirmations: confirmations(candles, okx, kucoin, binance),
      intelligence
    };
    signals.push(buildSignal(snapshot));
  }
  if (!signals.length) {
    console.log("INTERNAL TEST: no signals built; no Telegram message sent.");
    return;
  }
  const accepted = signals.filter(isRealEntrySignal).sort((a, b) => b.score - a.score);
  if (accepted[0]) await notifier.signal(accepted[0]);
  console.log(accepted[0] ? formatSignal(accepted[0]) : "INTERNAL TEST: no real executable entry; no Telegram message sent.");
}

async function loadBybit(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of tfs) {
    const candles = await client.bybitKlines(symbol, tf, "linear", 80);
    if (!Array.isArray(candles) || !candles.length) throw new Error(`Bybit futures candles empty ${symbol} ${tf}`);
    out[tf] = candles;
  }
  return out;
}

function emptyCandles() {
  return Object.fromEntries(tfs.map((tf) => [tf, [] as Candle[]]));
}

async function loadOkx(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.okxKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadKucoin(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.kucoinKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadBinance(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.binanceKlines(symbol, tf).catch(() => [])] as const)));
}

function liquidity(candles: Candle[]) {
  if (!Array.isArray(candles) || !candles.length) return 0;
  const dollarVolume = candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function confirmations(bybit: Record<string, Candle[]>, okx: Record<string, Candle[]>, kucoin: Record<string, Candle[]>, binance: Record<string, Candle[]>): ExchangeConfirmations {
  const bybitDir = direction(bybit["15"]);
  const okxDir = direction(okx["15"]);
  const kucoinDir = direction(kucoin["15"]);
  const binanceDir = direction(binance["15"]);
  const okxAligned = okxDir !== 0 && okxDir === bybitDir;
  const kucoinAligned = kucoinDir !== 0 && kucoinDir === bybitDir;
  const binanceAligned = binanceDir !== 0 && binanceDir === bybitDir;
  const conflict = [okxDir, kucoinDir].some((dir) => dir !== 0 && bybitDir !== 0 && dir !== bybitDir);
  return { bybit: bybitDir !== 0, okx: okxAligned, kucoin: kucoinAligned, binance: binanceAligned, alignedCount: [bybitDir !== 0, okxAligned, kucoinAligned, binanceAligned].filter(Boolean).length, conflict, details: [] };
}

function direction(candles?: Candle[]) {
  if (!candles || candles.length < 30) return 0;
  const last = candles.at(-1)!;
  const previous = candles.at(-20)!;
  if (last.close > previous.close) return 1;
  if (last.close < previous.close) return -1;
  return 0;
}

function formatSignal(signal: Signal) {
  const direction = signal.side === "SHORT" ? "SHORT" : "LONG";
  return [
    `🚨 SIGNAL: ${direction}`,
    "",
    "📍 Pair:",
    signal.symbol,
    "",
    "🎯 Entry:",
    `${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    "",
    "🛡 Stop Loss:",
    fmt(signal.stopLoss),
    "",
    "💰 Take Profit:",
    `TP1 ${fmt(signal.takeProfit[0])} / TP2 ${fmt(signal.takeProfit[1])} / TP3 ${fmt(signal.takeProfit[2])}`,
    "",
    "⚡ Leverage:",
    signal.score >= 96 ? "x3" : "x2",
    "",
    "📈 Confidence:",
    `${signal.confidence}%`,
    "",
    "📊 Reason:",
    "RSI, MACD, SMA trend and confirmations aligned."
  ].join("\n");
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value.toFixed(5);
}


main().catch((err) => {
  console.error("Помилка реального тесту сигналу", err instanceof Error ? err.message : err);
  process.exit(1);
});
