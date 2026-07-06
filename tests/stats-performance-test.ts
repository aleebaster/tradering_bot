import fs from "node:fs";
import path from "node:path";
import { TelegramCommandCenter, type TelegramCommandHandler } from "../src/local/telegramCommands";
import { performanceText, realTradeQualityAdjustment, recordTradeMemory, tradeStatsText, type TradeResult } from "../src/local/tradeMemory";
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
  const filePath = path.join(process.cwd(), "data", "trade-memory.json");
  const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ trades: [], updatedAt: new Date().toISOString() }, null, 2));
    seedTrades();

    const stats = tradeStatsText();
    const performance = performanceText();
    const adjustment = realTradeQualityAdjustment(mockSignal("SOLUSDT", 92, "LONG", "liquidity"));
    const notifier = new CaptureNotifier();
    const center = new TelegramCommandCenter(notifier);
    await center.handleForTest("/stats");
    await center.handleForTest("/performance");
    const commandText = notifier.messages.join("\n");

    const checks = {
      statsShowsWinRate: stats.includes("Win rate") && stats.includes("Best setup"),
      performanceShowsRealMemory: performance.includes("Real Strategy Performance") && performance.includes("Setup performance"),
      commandsWork: commandText.includes("Trading Stats") && commandText.includes("Real Strategy Performance"),
      adjustmentIsBounded: adjustment > 0 && adjustment <= 2.5
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    console.log(JSON.stringify({ ok: failed.length === 0, checks, adjustment, preview: performance.slice(0, 500) }, null, 2));
    if (failed.length) process.exit(1);
  } finally {
    if (backup === null) fs.rmSync(filePath, { force: true });
    else fs.writeFileSync(filePath, backup);
  }
}

function seedTrades() {
  const outcomes: TradeResult[] = ["TP3", "TP2", "TP1", "TP3", "TP2", "TP1", "TP3", "SL", "TP2", "TP1", "SL", "TP3"];
  outcomes.forEach((outcome, index) => {
    const symbol = index < 8 ? "SOLUSDT" : index < 10 ? "ETHUSDT" : "DOGEUSDT";
    const signal = mockSignal(symbol, outcome === "SL" ? 86 : 92, index % 2 ? "SHORT" : "LONG", index < 8 ? "liquidity" : "breakout");
    const current = outcome === "SL" ? signal.stopLoss : signal.takeProfit[outcome === "TP3" ? 2 : outcome === "TP2" ? 1 : 0];
    recordTradeMemory({ ...signal, id: `${signal.id}-${index}`, createdAt: new Date(Date.now() - (index + 1) * 600_000).toISOString() }, outcome, current);
  });
}

function mockSignal(symbol: string, score: number, side: "LONG" | "SHORT", setup: "liquidity" | "breakout"): Signal {
  const liquidity = setup === "liquidity" ? 82 : 58;
  const mtf = setup === "breakout" ? 78 : 70;
  return {
    id: `${symbol}-${Date.now()}`,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    symbol,
    mode: "futures",
    side,
    score,
    winProbability: score,
    confidence: score,
    grade: score >= 90 ? "A" : "B",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    session: { name: "NEW_YORK_OPEN", active: true, confidenceAdjustment: 0, message: "test" },
    newsRisk: { blocked: false, severity: "LOW", message: "test", reasons: [] },
    higherTimeframe: { direction: side === "SHORT" ? -1 : 1, aligned: true, executionAligned: true, counterTrend: false, confidenceAdjustment: 0, score: 70, details: [] },
    liquidityIntelligence: { direction: side === "SHORT" ? -1 : 1, score: liquidity, sweptAbove: side === "SHORT", sweptBelow: side === "LONG", liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "test" },
    orderFlow: { cvd: side === "SHORT" ? -1 : 1, direction: side === "SHORT" ? -1 : 1, score: 72, trapRisk: false, message: "test" },
    openInterestAnalysis: { direction: side === "SHORT" ? -1 : 1, score: 65, message: "test" },
    fakeBreakout: { risk: false, score: 80, reasons: [], message: "test" },
    fastMoveQuality: { clean: true, score: 75, message: "test", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 1, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: 1,
    entryStatus: "ENTER_NOW",
    entry: [0.99, 1.01],
    stopLoss: side === "SHORT" ? 1.04 : 0.96,
    takeProfit: side === "SHORT" ? [0.97, 0.94, 0.9] : [1.04, 1.07, 1.11],
    leverage: "x2",
    riskReward: "1:3",
    invalidationLevel: side === "SHORT" ? 1.04 : 0.96,
    holdTime: "test",
    marketRegime: setup === "breakout" ? "BREAKOUT" : "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: true, kucoin: false, kraken: false, binance: true, alignedCount: 3, conflict: false, details: [] },
    reasons: ["test"],
    rejectionReason: "test",
    scoreBreakdown: {
      liquiditySweep: liquidity,
      volumeConfirmation: 72,
      openInterestConfirmation: 65,
      momentumQuality: 74,
      orderBookImbalance: 66,
      entrySniper: 100,
      multiTimeframeAlignment: mtf,
      higherTimeframeBias: 70,
      executionAlignment: 100,
      fakeBreakoutProtection: 80,
      cvdOrderFlow: 72,
      smartOpenInterest: 65
    },
    tradeManagementActions: [],
    management: "test"
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
