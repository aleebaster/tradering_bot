import { ExchangeClient } from "../src/local/exchanges";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import { TelegramNotifier } from "../src/local/telegram";
import type { Candle, ExchangeConfirmations, MarketSnapshot, Signal } from "../src/local/types";

const client = new ExchangeClient();
const notifier = new TelegramNotifier();
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const tfs = ["5", "15", "60"];

async function main() {
  let btcCandles: Record<string, Candle[]>;
  try {
    btcCandles = await loadBybit("BTCUSDT");
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = [
      "❌ NO TRADE BTCUSDT / ETHUSDT / SOLUSDT",
      "",
      "Причини:",
      "• головне джерело Bybit тимчасово недоступне",
      `• raw Bybit error: ${raw}`,
      "• без Bybit як головного джерела production-сигнал заборонено",
      "• якість важливіша за кількість"
    ].join("\n");
    await notifier.send(message);
    console.log(message);
    return;
  }
  const btcOk = btcStable(btcCandles);
  const signals: Signal[] = [];
  for (const symbol of symbols) {
    const candles = symbol === "BTCUSDT" ? btcCandles : await loadBybit(symbol);
    const [okx, kucoin, kraken, binance, imbalance, funding, oi] = await Promise.all([
      loadOkx(symbol),
      loadKucoin(symbol),
      loadKraken(symbol),
      loadBinance(symbol),
      client.orderBookImbalance(symbol).catch(() => 0),
      client.fundingRate(symbol).catch(() => 0),
      client.openInterestChange(symbol).catch(() => 0)
    ]);
    const snapshot: MarketSnapshot = {
      symbol,
      mode: "futures",
      candles,
      okxCandles: okx,
      kucoinCandles: kucoin,
      krakenCandles: kraken,
      binanceCandles: binance,
      orderBookImbalance: imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore: liquidity(candles["15"]),
      whaleScore: Math.min(100, Math.max(0, Math.abs(oi) * 2500 + Math.abs(imbalance) * 120)),
      btcStable: symbol === "BTCUSDT" ? true : btcOk,
      regime: regimeFrom(candles),
      confirmations: confirmations(candles, okx, kucoin, kraken, binance)
    };
    signals.push(buildSignal(snapshot));
  }
  const accepted = signals.filter((s) => s.side !== "NO_TRADE").sort((a, b) => b.score - a.score);
  const message = accepted[0] ? formatSignal(accepted[0]) : formatNoTrade(signals);
  await notifier.send(message);
  console.log(message);
}

async function loadBybit(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of tfs) out[tf] = await client.bybitKlines(symbol, tf, "linear", 80);
  return out;
}

async function loadOkx(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.okxKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadKucoin(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.kucoinKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadKraken(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.krakenSpotKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadBinance(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.binanceKlines(symbol, tf).catch(() => [])] as const)));
}

function liquidity(candles: Candle[]) {
  const dollarVolume = candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function confirmations(bybit: Record<string, Candle[]>, okx: Record<string, Candle[]>, kucoin: Record<string, Candle[]>, kraken: Record<string, Candle[]>, binance: Record<string, Candle[]>): ExchangeConfirmations {
  const bybitDir = direction(bybit["15"]);
  const okxDir = direction(okx["15"]);
  const kucoinDir = direction(kucoin["15"]);
  const krakenDir = direction(kraken["15"]);
  const binanceDir = direction(binance["15"]);
  const okxAligned = okxDir !== 0 && okxDir === bybitDir;
  const kucoinAligned = kucoinDir !== 0 && kucoinDir === bybitDir;
  const krakenAligned = krakenDir !== 0 && krakenDir === bybitDir;
  const binanceAligned = binanceDir !== 0 && binanceDir === bybitDir;
  const conflict = [okxDir, kucoinDir, krakenDir].some((dir) => dir !== 0 && bybitDir !== 0 && dir !== bybitDir);
  return { bybit: bybitDir !== 0, okx: okxAligned, kucoin: kucoinAligned, kraken: krakenAligned, binance: binanceAligned, alignedCount: [bybitDir !== 0, okxAligned, kucoinAligned, krakenAligned, binanceAligned].filter(Boolean).length, conflict, details: [] };
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
  return [
    `🚀 ${signal.side} ${signal.symbol}`,
    "",
    `📍 Зона входу: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    `🛑 Стоп-лосс: ${fmt(signal.stopLoss)}`,
    `🎯 TP1: ${fmt(signal.takeProfit[0])}`,
    `🎯 TP2: ${fmt(signal.takeProfit[1])}`,
    `🎯 TP3: ${fmt(signal.takeProfit[2])}`,
    "",
    `⚡ Плече: ${signal.leverage ?? "не використовується"} MAX x5`,
    "",
    `📊 Впевненість: ${signal.confidence}%`,
    `📈 Ймовірність успіху: ${signal.winProbability}%`,
    "",
    "📡 Підтверджено:",
    ...confirmationLines(signal),
    "",
    "Причини входу:",
    ...signal.reasons.map((reason) => `✅ ${reason}`),
    "",
    "Супровід угоди:",
    "• ENTER NOW: коли ціна всередині зони входу",
    "• WAIT: коли ціна поза зоною входу",
    "• MOVE SL TO BREAKEVEN: після TP1",
    "• TAKE PARTIAL PROFIT: на TP1/TP2",
    "• EXIT TRADE NOW: при SL, TP3, нестабільності BTC або розвороті тренду"
  ].join("\n");
}

function formatNoTrade(signals: Signal[]) {
  const lines = ["❌ НЕМАЄ ВАЛІДНОЇ УГОДИ З ВИСОКОЮ ЙМОВІРНІСТЮ", ""];
  for (const signal of signals) {
    lines.push(`❌ NO TRADE ${signal.symbol}`, "", "Причини:", `• ${signal.rejectionReason}`, ...signal.reasons.map((reason) => `• ${reason}`), `• Підтверджень бірж: ${signal.confirmations.alignedCount}/5`, `• Оцінка: ${signal.score}/100`, "");
  }
  lines.push("Чесний висновок: сканер зараз не бачить валідної high-probability угоди. Якість важливіша за кількість.");
  return lines.join("\n");
}

function confirmationLines(signal: Signal) {
  return [signal.confirmations.bybit ? "✅ Bybit" : "❌ Bybit", signal.confirmations.okx ? "✅ OKX" : "❌ OKX", signal.confirmations.kucoin ? "✅ KuCoin" : "❌ KuCoin", signal.confirmations.kraken ? "✅ Kraken" : "❌ Kraken", signal.confirmations.binance ? "✅ Binance market confirmation" : "❌ Binance market confirmation"];
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value.toFixed(5);
}

main().catch((err) => {
  console.error("Помилка реального тесту сигналу", err instanceof Error ? err.message : err);
  process.exit(1);
});
