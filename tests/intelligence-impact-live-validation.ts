import { ExchangeClient } from "../src/local/exchanges";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import type { IntelligenceBundle } from "../src/local/bots";
import type { Candle, MarketSnapshot, Signal } from "../src/local/types";

const client = new ExchangeClient();
const pumpDetector = new PumpDetectorBot();
const whaleTracker = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT", "HYPEUSDT", "1000PEPEUSDT"];

type Report = {
  symbol: string;
  baseScore: number;
  pumpImpact: number;
  whaleImpact: number;
  liqImpact: number;
  marketImpact: number;
  finalScore: number;
  baseResult: string;
  finalResult: string;
  accepted: boolean;
  blocker: string;
  exactCriticalBlockers: string[];
  intelligenceReasons: string[];
  qualityChange: string;
};

async function main() {
  const btcCandles = await loadCandles("BTCUSDT");
  const btcOk = btcStable(btcCandles);
  const reports: Report[] = [];

  for (const symbol of symbols) {
    const candles = symbol === "BTCUSDT" ? btcCandles : await loadCandles(symbol).catch(() => null);
    if (!candles) {
      reports.push(unavailable(symbol));
      continue;
    }
    const built = await buildReports(symbol, candles, symbol === "BTCUSDT" ? true : btcOk);
    reports.push(built);
    await sleep(350);
  }

  const before = summarize(reports, "base");
  const after = summarize(reports, "final");
  const falsePositiveBlocked = reports.filter((r) => ["LONG", "SHORT", "BUY", "WATCHLIST"].includes(r.baseResult) && r.finalResult === "NO_TRADE" && r.exactCriticalBlockers.length > 0).length;
  const watchlistImproved = reports.filter((r) => r.finalResult === "WATCHLIST" && r.finalScore > r.baseScore).length;
  const output = {
    scannedAt: new Date().toISOString(),
    symbols,
    beforeWithoutIntelligence: before,
    afterWithIntelligence: after,
    measurableImpact: {
      falsePositiveBlocked,
      watchlistImproved,
      averageScoreDelta: round(avg(reports.map((r) => r.finalScore - r.baseScore))),
      upgraded: reports.filter((r) => r.qualityChange === "UPGRADED").map((r) => r.symbol),
      downgraded: reports.filter((r) => r.qualityChange === "DOWNGRADED").map((r) => r.symbol),
      unchanged: reports.filter((r) => r.qualityChange === "UNCHANGED").map((r) => r.symbol)
    },
    reports
  };
  console.log(JSON.stringify(output, null, 2));
}

async function buildReports(symbol: string, candles: Record<string, Candle[]>, btcOk: boolean): Promise<Report> {
  const [orderBook, fundingRate, openInterestChange] = await Promise.all([
    client.bybitOrderBookStats(symbol).catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    client.fundingRate(symbol).catch(() => 0),
    client.openInterestChange(symbol).catch(() => 0)
  ]);
  const liquidityScore = liquidity(candles["15"]);
  const regime = regimeFrom(candles);
  const input = { symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: btcOk, regime };
  const intelligence: IntelligenceBundle = {
    pump: pumpDetector.analyze(input),
    whale: whaleTracker.analyze(input),
    liq: liqBot.analyze(input),
    market: marketReportBot.analyze(input),
    updatedAt: new Date().toISOString()
  };
  const baseSnapshot = snapshot(symbol, candles, orderBook.imbalance, fundingRate, openInterestChange, liquidityScore, btcOk, regime, undefined);
  const base = buildSignal(baseSnapshot);
  const final = buildSignal(snapshot(symbol, candles, orderBook.imbalance, fundingRate, openInterestChange, liquidityScore, btcOk, regime, intelligence));
  const attribution = impactAttribution(intelligence, final.score - base.score);
  const blockers = criticalBlockers(final);
  return {
    symbol,
    baseScore: base.score,
    pumpImpact: attribution.pump,
    whaleImpact: attribution.whale,
    liqImpact: attribution.liq,
    marketImpact: attribution.market,
    finalScore: final.score,
    baseResult: base.side,
    finalResult: final.side,
    accepted: !["NO_TRADE", "WATCHLIST"].includes(final.side),
    blocker: blockers[0] ?? final.rejectionReason,
    exactCriticalBlockers: blockers,
    intelligenceReasons: [
      `PumpDetector ${impactText(attribution.pump)}: ${intelligence.pump.reasons.join("; ")}`,
      `WhaleTracker ${impactText(attribution.whale)}: ${intelligence.whale.reasons.join("; ")}`,
      `LiqBot ${impactText(attribution.liq)}: ${intelligence.liq.reasons.join("; ")}`,
      `MarketReport ${impactText(attribution.market)}: ${intelligence.market.reasons.join("; ")}`
    ],
    qualityChange: qualityChange(base, final)
  };
}

function snapshot(symbol: string, candles: Record<string, Candle[]>, imbalance: number, fundingRate: number, openInterestChange: number, liquidityScore: number, btcOk: boolean, regime: MarketSnapshot["regime"], intelligence?: IntelligenceBundle): MarketSnapshot {
  return {
    symbol,
    mode: "futures",
    candles,
    okxCandles: {},
    kucoinCandles: {},
    krakenCandles: {},
    binanceCandles: {},
    orderBookImbalance: imbalance,
    fundingRate,
    openInterestChange,
    liquidityScore,
    whaleScore: intelligence?.whale.smartMoneyScore ?? Math.min(100, Math.max(0, Math.abs(openInterestChange) * 2500 + Math.abs(imbalance) * 120)),
    btcStable: btcOk,
    regime,
    confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit live impact validation"] },
    intelligence
  };
}

function impactAttribution(intelligence: IntelligenceBundle, totalDelta: number) {
  const raw = {
    pump: (intelligence.pump.pumpScore - 50) * 0.08 + (intelligence.pump.entryTiming === "NOW" ? 3 : intelligence.pump.entryTiming === "AVOID" ? -2 : 0) - (intelligence.pump.fakeBreakoutRisk >= 65 ? 4 : 0),
    whale: (intelligence.whale.smartMoneyScore - 50) * 0.08 - Math.max(0, intelligence.whale.trapRisk - 45) * 0.08 + (intelligence.whale.accumulation || intelligence.whale.distribution ? 2 : 0),
    liq: (intelligence.liq.entryQuality - 50) * 0.07 - Math.max(0, intelligence.liq.trapProbability - 45) * 0.07 + (intelligence.liq.reclaimConfirmed ? 2 : 0),
    market: (intelligence.market.marketAggression - 50) * 0.05 - Math.max(0, intelligence.market.riskScore - 50) * 0.04 + (intelligence.market.marketRegime === "RISK_ON" ? 2 : intelligence.market.marketRegime === "RISK_OFF" ? -3 : 0)
  };
  const rounded = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Math.round(value)])) as { pump: number; whale: number; liq: number; market: number };
  const shown = rounded.pump + rounded.whale + rounded.liq + rounded.market;
  const residual = totalDelta - shown;
  if (residual !== 0) {
    const candidate = (Object.entries(raw) as Array<[keyof typeof rounded, number]>)
      .filter(([, value]) => Math.sign(value) === Math.sign(residual))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? "market";
    rounded[candidate] += residual;
  }
  return rounded;
}

function criticalBlockers(signal: Signal) {
  const b = signal.scoreBreakdown;
  const blockers: string[] = [];
  if ((b.entrySniper ?? 0) < 70) blockers.push("No sniper trigger");
  if ((b.liquiditySweep ?? 0) < 65) blockers.push("No liquidity sweep/reclaim or retest");
  if ((b.volumeConfirmation ?? 0) < 65) blockers.push("Volume does not support move");
  if ((b.momentumQuality ?? 0) < 70) blockers.push("Momentum not confirmed or exhausted");
  if ((b.whaleTracker ?? 0) < 45 || signal.intelligence?.whale.trapRisk && signal.intelligence.whale.trapRisk >= 70) blockers.push("Whale trap/spoofing risk");
  if (signal.fakeBreakout.risk || (b.fakeBreakoutProtection ?? 0) < 50) blockers.push("Fake-breakout risk");
  if ((b.liqBot ?? 0) < 45 || signal.intelligence?.liq.trapProbability && signal.intelligence.liq.trapProbability >= 70) blockers.push("Liquidation reclaim not clean");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") blockers.push("BTC not stable");
  if (rrNumber(signal.riskReward) < 2) blockers.push("RR below 1:2");
  return [...new Set(blockers)];
}

async function loadCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "5", "15", "60", "240"]) {
    out[tf] = await client.bybitKlines(symbol, tf, "linear", 220);
    await sleep(120);
  }
  return out;
}

function summarize(reports: Report[], mode: "base" | "final") {
  const key = mode === "base" ? "baseResult" : "finalResult";
  return {
    acceptedEntries: reports.filter((r) => !["NO_TRADE", "WATCHLIST", "UNAVAILABLE"].includes(String(r[key]))).length,
    watchlist: reports.filter((r) => r[key] === "WATCHLIST").length,
    noTrade: reports.filter((r) => r[key] === "NO_TRADE").length,
    avgScore: round(avg(reports.map((r) => mode === "base" ? r.baseScore : r.finalScore)))
  };
}

function qualityChange(base: Signal, final: Signal) {
  if (final.score >= base.score + 4 || base.side === "NO_TRADE" && final.side === "WATCHLIST") return "UPGRADED";
  if (final.score <= base.score - 4 || base.side !== "NO_TRADE" && final.side === "NO_TRADE") return "DOWNGRADED";
  return "UNCHANGED";
}

function unavailable(symbol: string): Report {
  return { symbol, baseScore: 0, pumpImpact: 0, whaleImpact: 0, liqImpact: 0, marketImpact: 0, finalScore: 0, baseResult: "UNAVAILABLE", finalResult: "UNAVAILABLE", accepted: false, blocker: "Bybit data unavailable", exactCriticalBlockers: ["Bybit data unavailable"], intelligenceReasons: [], qualityChange: "UNCHANGED" };
}

function liquidity(candles: Candle[]) {
  const dollarVolume = candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function impactText(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function rrNumber(value: string) {
  return Number(value.match(/:\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? 0);
}

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
