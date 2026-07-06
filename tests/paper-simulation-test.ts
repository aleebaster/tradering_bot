import { forcePaperMemoryClose, paperMemoryStatsText, paperSetupConfidenceAdjustment } from "../src/local/paperTrading";
import type { Signal } from "../src/local/types";

const signal = mockSignal();
forcePaperMemoryClose(signal, 103);
const stats = paperMemoryStatsText();
const adjustment = paperSetupConfidenceAdjustment("liquidity_sweep_btc_stable");
const hasStatsTitle = stats.includes("Paper Trade Memory") || stats.includes("Памʼять paper-угод");
const hasWinrate = stats.includes("Virtual winrate") || stats.includes("Віртуальний winrate");
const hasRecent = stats.includes("Last 20 paper trades") || stats.includes("Останні 20 paper-угод");
const ok = hasStatsTitle && hasWinrate && hasRecent && Number.isFinite(adjustment);
console.log(JSON.stringify({ ok, adjustment, checks: { stats: hasStatsTitle, winrate: hasWinrate, recent: hasRecent } }, null, 2));
if (!ok) process.exit(1);

function mockSignal(): Signal {
  return {
    id: `paper-test-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: "TESTUSDT",
    mode: "futures",
    side: "WATCHLIST",
    score: 82,
    winProbability: 82,
    confidence: 82,
    grade: "B",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    session: { name: "LONDON_NY_OVERLAP", active: true, confidenceAdjustment: 0, message: "test" },
    newsRisk: { blocked: false, severity: "LOW", message: "test", reasons: [] },
    higherTimeframe: { direction: 1, aligned: true, executionAligned: true, counterTrend: false, confidenceAdjustment: 0, score: 80, details: [] },
    liquidityIntelligence: { direction: 1, score: 80, sweptAbove: false, sweptBelow: true, liquidityPoolAbove: 103, liquidityPoolBelow: 99, message: "test" },
    orderFlow: { cvd: 1, direction: 1, score: 70, trapRisk: false, message: "test" },
    openInterestAnalysis: { direction: 1, score: 70, message: "test" },
    fakeBreakout: { risk: false, score: 85, reasons: [], message: "test" },
    fastMoveQuality: { clean: true, score: 70, message: "test", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: 100,
    entryStatus: "NO_TRADE",
    entry: [99.8, 100.2],
    stopLoss: 99,
    takeProfit: [101, 102, 103],
    riskReward: "1:3.0",
    invalidationLevel: 99,
    holdTime: "test",
    marketRegime: "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: true, kucoin: false, kraken: false, binance: true, alignedCount: 3, conflict: false, details: [] },
    reasons: [],
    rejectionReason: "paper simulation test",
    scoreBreakdown: { momentumQuality: 80, volumeConfirmation: 75, multiTimeframeAlignment: 100, executionAlignment: 100, liquiditySweep: 80, fakeBreakoutProtection: 85, orderBookImbalance: 65, smcConfirmation: 60, cvdOrderFlow: 70, higherTimeframeBias: 80, smartOpenInterest: 70 },
    tradeManagementActions: [],
    management: "test"
  };
}
