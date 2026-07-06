import { ExchangeClient } from "../src/local/exchanges";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import type { MarketSnapshot } from "../src/local/types";

async function main() {
  const client = new ExchangeClient();
  const symbol = process.env.INTELLIGENCE_TEST_SYMBOL ?? "BTCUSDT";
  const candles = Object.fromEntries(await Promise.all(["1", "5", "15", "60", "240"].map(async (tf) => [tf, await client.bybitKlines(symbol, tf, "linear", 220)] as const)));
  const [orderBook, fundingRate, openInterestChange] = await Promise.all([
    client.bybitOrderBookStats(symbol),
    client.fundingRate(symbol),
    client.openInterestChange(symbol)
  ]);
  const primary = candles["15"];
  const liquidityScore = Math.min(100, Math.log10(Math.max(primary.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24, 1)) * 11);
  const regime = regimeFrom(candles);
  const input = { symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: btcStable(candles), regime };
  const intelligence = {
    pump: new PumpDetectorBot().analyze(input),
    whale: new WhaleTrackerBot().analyze(input),
    liq: new LiqBot().analyze(input),
    market: new MarketReportBot().analyze(input),
    updatedAt: new Date().toISOString()
  };
  const snapshot: MarketSnapshot = {
    symbol,
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
    btcStable: input.btcStable,
    regime,
    confirmations: { bybit: true, okx: false, kucoin: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit live intelligence test"] },
    intelligence
  };
  const signal = buildSignal(snapshot);
  const checks = {
    pumpCreated: intelligence.pump.pumpScore >= 0 && intelligence.pump.momentumStrength >= 0,
    whaleCreated: ["LONG", "SHORT", "NEUTRAL"].includes(intelligence.whale.whaleBias) && intelligence.whale.smartMoneyScore >= 0,
    liqCreated: intelligence.liq.liqSignalStrength >= 0 && intelligence.liq.entryQuality >= 0,
    marketCreated: intelligence.market.riskScore >= 0 && intelligence.market.marketAggression >= 0,
    realDataUsed: candles["1"].length > 50 && orderBook.depthUsdt > 0,
    scoringIntegrated: ["pumpDetector", "whaleTracker", "liqBot", "marketReport", "intelligenceBonus", "intelligencePenalty"].every((key) => key in signal.scoreBreakdown)
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, symbol, checks, intelligence, signalImpact: signal.scoreBreakdown, failed }, null, 2));
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
