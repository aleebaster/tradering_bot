import { activationConfirmed, fomoBlock, watchlistEvolution } from "../src/local/scanner";
import type { Signal } from "../src/local/types";

function main() {
  const prev = mockSignal("TESTUSDT", 87, "NO_TRADE");
  const ready = mockSignal("TESTUSDT", 92, "ENTER_NOW");
  const evolution = watchlistEvolution(prev, ready);
  const pumped = mockSignal("PUMPUSDT", 94, "ENTER_NOW", { currentPrice: 1.08, entry: [0.98, 1.01], fastClean: false });
  const waiting = mockSignal("WAITUSDT", 94, "WAIT_FOR_ENTRY", { currentPrice: 1.04, entry: [0.98, 1.01] });

  const checks = {
    evolvesIntoEntry: activationConfirmed(ready, evolution),
    blocksPump: fomoBlock(pumped).blocked && !activationConfirmed(pumped, watchlistEvolution(prev, pumped)),
    blocksOutsideEntryZone: fomoBlock(waiting).blocked && !activationConfirmed(waiting, watchlistEvolution(prev, waiting)),
    requiresSniper: !activationConfirmed({ ...ready, scoreBreakdown: { ...ready.scoreBreakdown, entrySniper: 40 } }, evolution),
    requiresBtcStable: !activationConfirmed({ ...ready, btcStable: false }, evolution)
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, fomoReasons: fomoBlock(pumped).reasons }, null, 2));
  if (failed.length) process.exit(1);
}

function mockSignal(symbol: string, score: number, entryStatus: Signal["entryStatus"], overrides: Partial<{ currentPrice: number; entry: [number, number]; fastClean: boolean }> = {}): Signal {
  const entry = overrides.entry ?? [0.99, 1.01];
  return {
    id: `${symbol}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol,
    mode: "futures",
    side: score >= 90 ? "LONG" : "WATCHLIST",
    score,
    winProbability: score,
    confidence: score,
    grade: score >= 90 ? "A" : "B",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    session: { name: "NEW_YORK_OPEN", active: true, confidenceAdjustment: 0, message: "test" },
    newsRisk: { blocked: false, severity: "LOW", message: "test", reasons: [] },
    higherTimeframe: { direction: 1, aligned: true, executionAligned: true, counterTrend: false, confidenceAdjustment: 0, score: 70, details: [] },
    liquidityIntelligence: { direction: 1, score: 78, sweptAbove: false, sweptBelow: true, liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "test" },
    orderFlow: { cvd: 1, direction: 1, score: 70, trapRisk: false, message: "test" },
    openInterestAnalysis: { direction: 1, score: 65, message: "test" },
    fakeBreakout: { risk: false, score: 80, reasons: [], message: "test" },
    fastMoveQuality: { clean: overrides.fastClean ?? true, score: overrides.fastClean === false ? 30 : 75, message: "test", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 1, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: overrides.currentPrice ?? 1,
    entryStatus,
    entry,
    stopLoss: 0.96,
    takeProfit: [1.04, 1.07, 1.11],
    riskReward: "1:3",
    invalidationLevel: 0.96,
    holdTime: "test",
    marketRegime: "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: true, kucoin: false, kraken: false, binance: true, alignedCount: 3, conflict: false, details: [] },
    reasons: ["test"],
    rejectionReason: "test",
    scoreBreakdown: {
      liquiditySweep: score >= 90 ? 76 : 55,
      volumeConfirmation: score >= 90 ? 72 : 58,
      openInterestConfirmation: score >= 90 ? 65 : 52,
      momentumQuality: score >= 90 ? 74 : 60,
      orderBookImbalance: score >= 90 ? 66 : 55,
      entrySniper: score >= 90 ? 100 : 35,
      multiTimeframeAlignment: score >= 90 ? 70 : 58,
      trendStrength: score >= 90 ? 50 : 40
    },
    tradeManagementActions: [],
    management: "test"
  };
}

main();
