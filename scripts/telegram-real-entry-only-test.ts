import { isRealEntrySignal, TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";
import type { Signal } from "../src/local/types";

class CaptureNotifier extends TelegramNotifier {
  messages: string[] = [];

  override async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

async function main() {
  const notifier = new CaptureNotifier();
  const real = signal({ side: "LONG", entryStatus: "ENTER_NOW", score: 94, currentPrice: 100.5 });
  const weak = signal({ side: "NO_TRADE", entryStatus: "NO_TRADE", score: 55, currentPrice: 100.5, rejectionReason: "Weak signal" });
  const watch = signal({ side: "WATCHLIST", entryStatus: "NO_TRADE", score: 86, currentPrice: 100.5, rejectionReason: "Wait for retest" });
  const outsideZone = signal({ side: "SHORT", entryStatus: "ENTER_NOW", score: 95, currentPrice: 103 });
  const fakeBreakout = signal({ side: "LONG", entryStatus: "ENTER_NOW", score: 95, currentPrice: 100.5, fakeBreakoutRisk: true });

  await notifier.signal(weak);
  await notifier.signal(watch);
  await notifier.signal(outsideZone);
  await notifier.signal(fakeBreakout);
  await notifier.pumpDetected(watch, ["pump"]);
  await notifier.setupInvalidated(watch, ["decay"]);
  await notifier.noTrade(weak);
  await notifier.setupUpgraded(real, ["entry ready"]);

  const message = notifier.messages.join("\n---\n");
  const forbidden = ["OPENCODE BOT", "NO TRADE", "Weak signal", "Waiting", "Watchlist", "Wait for retest", "ENTRY READY"];
  const checks = {
    realEntryGate: isRealEntrySignal(real) && !isRealEntrySignal(weak) && !isRealEntrySignal(watch) && !isRealEntrySignal(outsideZone) && !isRealEntrySignal(fakeBreakout),
    oneAutomaticMessage: notifier.messages.length === 1,
    requiredHeader: message.includes("🚨 SIGNAL: LONG"),
    requiredFields: ["🚨 SIGNAL: LONG", "📍 Pair:", "🎯 Entry:", "🛡 Stop Loss:", "💰 Take Profit:", "⚡ Leverage:", "📈 Confidence:", "📊 Reason:"].every((field) => message.includes(field)),
    spamRemoved: forbidden.every((item) => !message.includes(item))
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, messages: notifier.messages.length, failed }, null, 2));
  if (failed.length) process.exit(1);
}

function signal(patch: Partial<Signal> & { fakeBreakoutRisk?: boolean }): Signal {
  const side = patch.side ?? "LONG";
  return {
    id: "test",
    createdAt: new Date().toISOString(),
    symbol: "BTCUSDT",
    mode: "futures",
    side,
    score: patch.score ?? 94,
    winProbability: patch.score ?? 94,
    confidence: patch.score ?? 94,
    grade: "A+",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    session: { name: "LONDON_NY_OVERLAP", active: true, confidenceAdjustment: 5, message: "ok" },
    newsRisk: { blocked: false, severity: "LOW", message: "ok", reasons: [] },
    higherTimeframe: { direction: side === "SHORT" ? -1 : 1, aligned: true, executionAligned: true, counterTrend: false, confidenceAdjustment: 0, score: 80, details: [] },
    liquidityIntelligence: { direction: side === "SHORT" ? -1 : 1, score: 80, sweptAbove: side === "SHORT", sweptBelow: side !== "SHORT", liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "ok" },
    orderFlow: { cvd: 1, direction: side === "SHORT" ? -1 : 1, score: 75, trapRisk: false, message: "ok" },
    openInterestAnalysis: { direction: side === "SHORT" ? -1 : 1, score: 72, message: "ok" },
    fakeBreakout: { risk: Boolean(patch.fakeBreakoutRisk), score: 90, reasons: [], message: "ok" },
    fastMoveQuality: { clean: true, score: 80, message: "ok", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: patch.currentPrice ?? 100.5,
    entryStatus: patch.entryStatus ?? "ENTER_NOW",
    entry: [100, 101],
    stopLoss: side === "SHORT" ? 102 : 98,
    takeProfit: side === "SHORT" ? [99, 97, 95] : [102, 104, 106],
    leverage: "x2",
    positionSizing: { balanceUsdt: 5, marginUsdt: 2.5, leverage: "x2", positionSizeUsdt: 5, quantity: 0.05, baseAsset: "BTC", entryRange: [100, 101], averageEntry: 100.5, stopLoss: side === "SHORT" ? 102 : 98, takeProfit: side === "SHORT" ? [99, 97, 95] : [102, 104, 106], maxRiskPercent: 2, accountRiskPercent: 1.5, priceRiskPercent: 2.5, potentialLossUsdt: 0.08, potentialProfitUsdt: [0.12, 0.22, 0.35], liquidationSafety: "safe", liquidationSafetyPercent: 50 },
    riskReward: "1:3.0",
    invalidationLevel: side === "SHORT" ? 102 : 98,
    holdTime: "30 хвилин до 6 годин",
    marketRegime: "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: true, alignedCount: 2, conflict: false, details: [] },
    reasons: ["ok"],
    rejectionReason: patch.rejectionReason ?? "Прийнятий сетап з високою ймовірністю",
    scoreBreakdown: { adaptiveConfirmationRequired: 92, entrySniper: 100, volumeConfirmation: 75, momentumQuality: 78, orderBookImbalance: 68, liquiditySweep: 76, multiTimeframeAlignment: 72 },
    tradeManagementActions: [],
    management: "active"
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
