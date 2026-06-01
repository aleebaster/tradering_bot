import { formatDecisionSignal, TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";
import { loadTelegramSettings, updateTelegramSettings } from "../src/local/telegramSettings";
import type { Signal } from "../src/local/types";

class CaptureNotifier extends TelegramNotifier {
  messages: string[] = [];

  override async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

async function main() {
  const originalSettings = loadTelegramSettings();
  updateTelegramSettings({ balanceUsdt: 5 });
  const notifier = new CaptureNotifier();
  const long = formatDecisionSignal(sampleSignal("LONG"));
  const short = formatDecisionSignal(sampleSignal("SHORT"));
  const wait = formatDecisionSignal(sampleSignal("WAIT"));

  await notifier.send(long);
  await notifier.send(short);
  await notifier.send(wait);
  updateTelegramSettings(originalSettings);

  const checks = {
    noLiveTelegramSpam: notifier.messages.length === 3,
    longDirection: long.includes("🟢 SIGNAL — BTCUSDT") && long.includes("📍 НАПРЯМОК: LONG 🟢") && !long.includes("ПОТЕНЦІЙНИЙ LONG"),
    shortDirection: short.includes("🔴 SIGNAL — DOGEUSDT") && short.includes("📍 НАПРЯМОК: SHORT 🔴") && !short.includes("ПОТЕНЦІЙНИЙ SHORT"),
    enterStatus: long.includes("🟢 LONG — МОЖНА ВХОДИТИ") && short.includes("🔴 SHORT — МОЖНА ВХОДИТИ"),
    waitStatus: wait.includes("⚪ SIGNAL — PEPEUSDT") && wait.includes("⚪ ПОТЕНЦІЙНИЙ LONG") && wait.includes("📍 ПОТЕНЦІЙНИЙ НАПРЯМОК: LONG 🟢") && wait.includes("❌ ЩЕ НЕ ВХОДИТИ") && !wait.includes("📍 НАПРЯМОК: LONG 🟢") && !wait.includes("🟢 LONG — МОЖНА ВХОДИТИ"),
    scoreSplit: long.includes("SETUP SCORE: 91%") && /ENTRY CONFIDENCE: \d+%/.test(long) && wait.includes("SETUP SCORE: 72%") && /ENTRY CONFIDENCE: \d+%/.test(wait),
    activeAllocation: long.includes("🎯 TP1: 72600.00") && long.includes("Закрити: 40%") && long.includes("🎯 TP2: 73100.00") && long.includes("Закрити: 30%") && long.includes("🎯 TP3: 73800.00") && long.includes("Закрити: 20%"),
    activeRisk: long.includes("💰 Bank: $5 USDT") && long.includes("💵 Margin used: $5 USDT") && long.includes("⚙️ Margin: Isolated 2x") && long.includes("📦 Position size: $10") && long.includes("⚠️ Risk: ~") && long.includes("Qty: ~") && long.includes("auto from $5 balance") && long.includes("ROI"),
    entryTypeExplained: long.includes("🟡 LIMIT ENTRY —") && wait.includes("⚪ WAIT FOR RETEST —"),
    inactiveRiskForWait: wait.includes("⚠️ Risk: inactive") && !wait.includes("Qty: auto") && wait.includes("weak volume") && wait.includes("execution not confirmed")
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, proof: { long, short, wait }, failed }, null, 2));
  if (failed.length) process.exit(1);
}

function sampleSignal(kind: "LONG" | "SHORT" | "WAIT"): Signal {
  const long = kind === "LONG";
  const wait = kind === "WAIT";
  return {
    id: kind,
    createdAt: new Date().toISOString(),
    symbol: long ? "BTCUSDT" : kind === "SHORT" ? "DOGEUSDT" : "PEPEUSDT",
    mode: "futures",
    side: wait ? "WATCHLIST" : long ? "LONG" : "SHORT",
    score: wait ? 72 : long ? 91 : 85,
    winProbability: 70,
    confidence: wait ? 55 : long ? 91 : 75,
    grade: "A",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    session: { name: "NEW_YORK_OPEN", active: true, confidenceAdjustment: 0, message: "test" },
    newsRisk: { blocked: false, severity: "LOW", message: "ok", reasons: [] },
    higherTimeframe: { direction: long ? 1 : -1, aligned: true, executionAligned: !wait, counterTrend: false, confidenceAdjustment: 0, score: 80, details: [] },
    liquidityIntelligence: { direction: long ? 1 : -1, score: wait ? 40 : 80, sweptAbove: false, sweptBelow: false, liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "test" },
    orderFlow: { cvd: 1, direction: long ? 1 : -1, score: 75, trapRisk: false, message: "test" },
    openInterestAnalysis: { direction: 1, score: 75, message: "test" },
    fakeBreakout: { risk: wait, score: wait ? 30 : 85, reasons: wait ? ["fake breakout risk"] : [], message: "test" },
    fastMoveQuality: { clean: !wait, score: wait ? 40 : 80, message: "test", reasons: [] },
    correlation: { btcDirection: 1, ethDirection: 1, total3Direction: 1, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: true, riskOff: false, details: [] },
    currentPrice: long ? 72_260 : kind === "SHORT" ? 0.0999 : 0.00001,
    entryStatus: wait ? "WAIT_FOR_ENTRY" : "ENTER_NOW",
    entry: long ? [72_227, 72_322] : kind === "SHORT" ? [0.099842, 0.099992] : [0.00001, 0.000011],
    stopLoss: long ? 71_950 : kind === "SHORT" ? 0.100353 : 0.000009,
    takeProfit: long ? [72_600, 73_100, 73_800] : kind === "SHORT" ? [0.099394, 0.099046, 0.09733] : [0.000012, 0.000013, 0.000014],
    riskReward: "1:2.4",
    invalidationLevel: 0,
    holdTime: "scalp",
    marketRegime: "TRENDING",
    btcStable: true,
    confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: false, alignedCount: 1, conflict: false, details: [] },
    reasons: [],
    rejectionReason: wait ? "waiting confirmation" : "",
    scoreBreakdown: { adaptiveConfirmationRequired: 80, entrySniper: wait ? 35 : 80, volumeConfirmation: wait ? 40 : 75, momentumQuality: wait ? 45 : 80, orderBookImbalance: wait ? 50 : 75, liquiditySweep: wait ? 30 : 80, multiTimeframeAlignment: 70, openInterestConfirmation: 70 },
    tradeManagementActions: [],
    management: "test"
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
