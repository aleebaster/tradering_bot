import { state } from "../src/local/state";
import { TelegramCommandCenter, type TelegramCommandHandler } from "../src/local/telegramCommands";
import type { TelegramReplyMarkup } from "../src/local/telegram";
import type { Signal } from "../src/local/types";

class CaptureNotifier implements TelegramCommandHandler {
  messages: string[] = [];
  async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

async function main() {
  process.env.TELEGRAM_HANDLER_TEST = "1";
  state.watchlist = [mockSignal("BSBUSDT", 89), mockSignal("NVDAUSDT", 86), mockSignal("TESTUSDT", 82)];
  const notifier = new CaptureNotifier();
  const center = new TelegramCommandCenter(notifier);
  await center.handleForTest("/watchstatus");
  const text = notifier.messages.join("\n");
  const checks = {
    commandWorks: text.includes("ТОП WATCHLIST"),
    rankedClosestFirst: text.indexOf("#1 BSBUSDT") >= 0 && text.indexOf("#1 BSBUSDT") < text.indexOf("#2 NVDAUSDT"),
    readinessShown: text.includes("Estimated readiness"),
    missingShown: text.includes("Waiting for") && text.includes("sniper trigger")
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, failed, preview: text.slice(0, 600) }, null, 2));
  if (failed.length) process.exit(1);
}

function mockSignal(symbol: string, score: number): Signal {
  return {
    id: `${symbol}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol,
    mode: "futures",
    side: "WATCHLIST",
    score,
    winProbability: score,
    confidence: score,
    grade: score >= 85 ? "B" : "C",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    session: { name: "NEW_YORK_OPEN", active: true, confidenceAdjustment: 0, message: "test" },
    newsRisk: { blocked: false, severity: "LOW", message: "test", reasons: [] },
    higherTimeframe: { direction: 1, aligned: true, executionAligned: true, counterTrend: false, confidenceAdjustment: 0, score: 65, details: [] },
    liquidityIntelligence: { direction: 1, score: 72, sweptAbove: false, sweptBelow: true, liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "test" },
    orderFlow: { cvd: 1, direction: 1, score: 62, trapRisk: false, message: "test" },
    openInterestAnalysis: { direction: 1, score: 60, message: "test" },
    fakeBreakout: { risk: false, score: 70, reasons: [], message: "test" },
    fastMoveQuality: { clean: true, score: 70, message: "test", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: 1,
    entryStatus: "NO_TRADE",
    entry: [0.98, 1.01],
    stopLoss: 0.95,
    takeProfit: [1.03, 1.06, 1.1],
    riskReward: "1:3",
    invalidationLevel: 0.95,
    holdTime: "test",
    marketRegime: "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: false, alignedCount: 1, conflict: false, details: [] },
    reasons: ["test"],
    rejectionReason: "waiting for sniper trigger",
    scoreBreakdown: {
      liquiditySweep: score >= 86 ? 72 : 45,
      volumeConfirmation: score >= 86 ? 68 : 50,
      openInterestConfirmation: score >= 86 ? 60 : 50,
      momentumQuality: score >= 89 ? 72 : 55,
      orderBookImbalance: score >= 86 ? 62 : 45,
      entrySniper: score >= 90 ? 75 : 35
    },
    tradeManagementActions: [],
    management: "watch"
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
