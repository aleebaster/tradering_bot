import { ExchangeClient } from "./exchanges";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "./bots";
import { btcStable, buildSignal, regimeFrom } from "./scoring";
import { resolvePair } from "./marketRegistry";
import type { Candle, MarketSnapshot, Signal } from "./types";

const client = new ExchangeClient();
const pump = new PumpDetectorBot();
const whale = new WhaleTrackerBot();
const liq = new LiqBot();
const market = new MarketReportBot();

export async function analyzeFutures(query: string): Promise<Signal> {
  const resolved = await resolvePair(query);
  const item = resolved.futures[0];
  if (!item) throw new Error(`Futures pair not found for ${query}`);
  const [candles, btcCandles] = await Promise.all([loadFuturesCandles(item.symbol), loadFuturesCandles("BTCUSDT")]);
  const btcOk = item.symbol === "BTCUSDT" ? true : btcStable(btcCandles);
  const [orderBook, fundingRate, openInterestChange] = await Promise.all([
    client.bybitOrderBookStats(item.symbol, item.marketType === "inverse" ? "inverse" : "linear").catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    item.marketType === "linear" ? client.fundingRate(item.symbol).catch(() => 0) : Promise.resolve(0),
    item.marketType === "linear" ? client.openInterestChange(item.symbol).catch(() => 0) : Promise.resolve(0)
  ]);
  const liquidityScore = Math.min(100, Math.log10(Math.max(item.turnover24h, 1)) * 10);
  const regime = regimeFrom(candles);
  const input = { symbol: item.symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: btcOk, regime };
  const intelligence = { pump: pump.analyze(input), whale: whale.analyze(input), liq: liq.analyze(input), market: market.analyze(input), updatedAt: new Date().toISOString() };
  const snapshot: MarketSnapshot = {
    symbol: item.symbol,
    mode: "futures",
    candles,
    okxCandles: {},
    kucoinCandles: {},
    binanceCandles: {},
    orderBookImbalance: orderBook.imbalance,
    fundingRate,
    openInterestChange,
    liquidityScore,
    whaleScore: intelligence.whale.smartMoneyScore,
    btcStable: btcOk,
    regime,
    confirmations: { bybit: true, okx: false, kucoin: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit registry analysis"] },
    intelligence
  };
  return buildSignal(snapshot);
}

export async function loadFuturesCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "3", "5", "15", "60"]) out[tf] = await client.bybitKlines(symbol, tf, "linear", 180);
  return out;
}
