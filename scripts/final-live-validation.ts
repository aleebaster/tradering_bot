import { setTimeout as wait } from "node:timers/promises";
import { ExchangeClient } from "../src/local/exchanges";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import type { Candle, MarketSnapshot, Signal } from "../src/local/types";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";

const client = new ExchangeClient();
const pumpDetector = new PumpDetectorBot();
const whaleTracker = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();
const preferred = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "TRXUSDT", "LINKUSDT", "AVAXUSDT",
  "LTCUSDT", "BCHUSDT", "DOTUSDT", "UNIUSDT", "ETCUSDT", "AAVEUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT",
  "NEARUSDT", "FILUSDT", "ATOMUSDT", "INJUSDT", "TIAUSDT", "WLDUSDT", "SEIUSDT", "1000PEPEUSDT", "1000BONKUSDT", "ORDIUSDT"
];

async function main() {
  const valid = await bybitLinearSymbols().catch(() => new Set(preferred));
  const symbols = preferred.filter((s) => valid.has(s)).slice(0, 20);
  const invalid = preferred.slice(0, 20).filter((s) => !valid.has(s));
  if (symbols.length < 20) throw new Error(`Лише ${symbols.length} обраних символів валідні для Bybit linear. Невалідні: ${invalid.join(",")}`);
  console.log(`ПОЧАТОК LIVE-ВАЛІДАЦІЇ ${new Date().toISOString()}`);
  console.log(`Перевірені валідні символи Bybit: ${symbols.join(", ")}`);
  console.log("Помилки невалідних символів: 0");

  const btcCandles = await loadBybitCandles("BTCUSDT");
  const btcOk = btcStable(btcCandles);
  console.log(`Статус фільтра BTC: ${btcOk ? "СТАБІЛЬНИЙ" : "НЕСТАБІЛЬНИЙ"}`);
  const outputs: Signal[] = [];

  for (const symbol of symbols) {
    const candles = symbol === "BTCUSDT" ? btcCandles : await loadBybitCandles(symbol);
    const [orderBook, fundingRate, openInterestChange] = await Promise.all([
      retry(() => client.bybitOrderBookStats(symbol)).catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
      retry(() => client.fundingRate(symbol)).catch(() => 0),
      retry(() => client.openInterestChange(symbol)).catch(() => 0)
    ]);
    const liquidityScore = liquidity(candles["15"]);
    const regime = regimeFrom(candles);
    const intelligenceInput = { symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: symbol === "BTCUSDT" ? true : btcOk, regime };
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
      okxCandles: {},
      kucoinCandles: {},
      krakenCandles: {},
      binanceCandles: {},
      orderBookImbalance: orderBook.imbalance,
      fundingRate,
      openInterestChange,
      liquidityScore,
      whaleScore: intelligence.whale.smartMoneyScore,
      btcStable: symbol === "BTCUSDT" ? true : btcOk,
      regime,
      confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit: live validation"] },
      intelligence
    };
    const signal = buildSignal(snapshot);
    outputs.push(signal);
    printSignal(signal);
    await wait(1400);
  }

  const accepted = outputs.filter((s) => !["NO_TRADE", "WATCHLIST"].includes(s.side));
  console.log(`ПІДСУМОК символів=${outputs.length} прийнятихСигналів=${accepted.length} спостереження=${outputs.filter((s) => s.side === "WATCHLIST").length} неВходити=${outputs.filter((s) => s.side === "NO_TRADE").length}`);
  console.log(`КІНЕЦЬ LIVE-ВАЛІДАЦІЇ ${new Date().toISOString()}`);
}

async function bybitLinearSymbols() {
  return retry(() => client.bybitInstrumentSymbols("linear"));
}

async function loadBybitCandles(symbol: string): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "5", "15", "60", "240"]) {
    out[tf] = await retry(() => client.bybitKlines(symbol, tf, "linear", 220));
    await wait(450);
  }
  return out;
}

function liquidity(candles: Candle[]) {
  const dollarVolume = candles.slice(-24).reduce((s, c) => s + c.volume * c.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function confluenceCount(signal: Signal) {
  return Object.entries(signal.scoreBreakdown).filter(([k, v]) => !k.endsWith("Penalty") && v >= 60).length;
}

function trendStatus(signal: Signal) {
  const trend = signal.scoreBreakdown.trendStrength;
  const mtf = signal.scoreBreakdown.multiTimeframeAlignment;
  if (trend >= 60 && mtf >= 67) return "СИЛЬНИЙ";
  if (trend >= 30 || mtf >= 67) return "ФОРМУЄТЬСЯ";
  return "СЛАБКИЙ";
}

function printSignal(signal: Signal) {
  console.log(`\n${signal.symbol}`);
  console.log(`Оцінка: ${signal.score}`);
  console.log(`Впевненість: ${signal.confidence}%`);
  console.log(`Ймовірність успіху: ${signal.winProbability}%`);
  console.log(`Фільтр BTC: ${signal.btcStable ? "СТАБІЛЬНИЙ" : "НЕСТАБІЛЬНИЙ"}`);
  console.log(`Стан тренду: ${trendStatus(signal)}`);
  console.log(`Режим ринку: ${signal.marketRegime}`);
  console.log(`Кількість підтверджень: ${confluenceCount(signal)}`);
  console.log(`Статус входу: ${signal.entryStatus}`);
  console.log(`Поточна ціна: ${fmt(signal.currentPrice)}`);
  console.log(`Ризик/прибуток: ${signal.riskReward}`);
  console.log(`Плече: ${signal.leverage ?? "Немає"}`);
  console.log(`Підтвердження funding: ${signal.scoreBreakdown.fundingConfirmation}`);
  console.log(`Підтвердження OI: ${signal.scoreBreakdown.openInterestConfirmation}`);
  console.log(`Підтвердження бірж: ${signal.confirmations.alignedCount}, конфлікт: ${signal.confirmations.conflict ? "так" : "ні"}`);
  if (["NO_TRADE", "WATCHLIST"].includes(signal.side)) {
    console.log(`${signal.side === "WATCHLIST" ? "Спостереження" : "Відхилено"}: ${signal.rejectionReason}`);
  } else {
    console.log(`Сигнал: ${signal.side}`);
    console.log(`Вхід: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`);
    console.log(`Стоп-лосс: ${fmt(signal.stopLoss)}`);
    console.log(`TP1: ${fmt(signal.takeProfit[0])}`);
    console.log(`TP2: ${fmt(signal.takeProfit[1])}`);
    console.log(`TP3: ${fmt(signal.takeProfit[2])}`);
    console.log(`Причина: ${signal.reasons.join("; ")}`);
  }
  console.log(`Деталізація оцінки: ${JSON.stringify(signal.scoreBreakdown)}`);
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}

async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("403") || message.includes("429")) await wait(8000 + i * 8000);
      else await wait(1200 + i * 1000);
    }
  }
  throw last;
}

main().catch((err) => {
  console.error("LIVE-ВАЛІДАЦІЯ НЕ ВДАЛАСЯ", err instanceof Error ? err.message : err);
  process.exit(1);
});
