import { logger } from "./logger";
import type { Signal, Side } from "./types";

export interface ValidationResult {
  valid: boolean;
  reason: string;
  correctedSignal?: Signal;
}

export function validateTrade(signal: Signal): ValidationResult {
  const directionCheck = validateDirectionIntegrity(signal);
  if (!directionCheck.valid) return directionCheck;

  const sltpCheck = validateStopLossTakeProfit(signal);
  if (!sltpCheck.valid) return sltpCheck;

  const riskRewardCheck = validateRiskReward(signal);
  if (!riskRewardCheck.valid) return riskRewardCheck;

  const positionCheck = validatePositionSizing(signal);
  if (!positionCheck.valid) return positionCheck;

  const criticalCheck = validateCriticalConditions(signal);
  if (!criticalCheck.valid) return criticalCheck;

  return { valid: true, reason: "All validations passed" };
}

function validateDirectionIntegrity(signal: Signal): ValidationResult {
  if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") {
    return { valid: true, reason: "Not an active trade signal" };
  }

  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const tp1 = signal.takeProfit[0];
  const tp2 = signal.takeProfit[1];
  const tp3 = signal.takeProfit[2];
  const sl = signal.stopLoss;

  if (signal.side === "LONG") {
    if (sl >= avgEntry) {
      logger.error({ symbol: signal.symbol, side: signal.side, entry: avgEntry, stopLoss: sl, tp1, tp2, tp3 }, "CRITICAL: LONG signal has SL >= Entry");
      return { valid: false, reason: `LONG signal has SL (${sl}) >= Entry (${avgEntry})` };
    }
    if (tp1 <= avgEntry || tp2 <= avgEntry || tp3 <= avgEntry) {
      logger.error({ symbol: signal.symbol, side: signal.side, entry: avgEntry, tp1, tp2, tp3 }, "CRITICAL: LONG signal has TP <= Entry");
      return { valid: false, reason: `LONG signal has one or more TP levels <= Entry` };
    }
    if (tp1 >= tp2 || tp2 >= tp3) {
      logger.error({ symbol: signal.symbol, tp1, tp2, tp3 }, "CRITICAL: LONG signal has non-ascending TP levels");
      return { valid: false, reason: `LONG signal TP levels must be ascending: TP1 < TP2 < TP3` };
    }
  }

  if (signal.side === "SHORT") {
    if (sl <= avgEntry) {
      logger.error({ symbol: signal.symbol, side: signal.side, entry: avgEntry, stopLoss: sl, tp1, tp2, tp3 }, "CRITICAL: SHORT signal has SL <= Entry");
      return { valid: false, reason: `SHORT signal has SL (${sl}) <= Entry (${avgEntry})` };
    }
    if (tp1 >= avgEntry || tp2 >= avgEntry || tp3 >= avgEntry) {
      logger.error({ symbol: signal.symbol, side: signal.side, entry: avgEntry, tp1, tp2, tp3 }, "CRITICAL: SHORT signal has TP >= Entry");
      return { valid: false, reason: `SHORT signal has one or more TP levels >= Entry` };
    }
    if (tp1 <= tp2 || tp2 <= tp3) {
      logger.error({ symbol: signal.symbol, tp1, tp2, tp3 }, "CRITICAL: SHORT signal has non-descending TP levels");
      return { valid: false, reason: `SHORT signal TP levels must be descending: TP1 > TP2 > TP3` };
    }
  }

  return { valid: true, reason: "Direction integrity OK" };
}

function validateStopLossTakeProfit(signal: Signal): ValidationResult {
  if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") {
    return { valid: true, reason: "Not an active trade signal" };
  }

  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const sl = signal.stopLoss;
  const risk = Math.abs(avgEntry - sl);

  if (risk <= 0) {
    logger.error({ symbol: signal.symbol, entry: avgEntry, stopLoss: sl }, "CRITICAL: Zero risk distance");
    return { valid: false, reason: "Stop loss distance from entry is zero" };
  }

  const riskPct = (risk / avgEntry) * 100;
  if (riskPct > 5) {
    logger.warn({ symbol: signal.symbol, riskPct }, "WARNING: Risk percentage exceeds 5%");
    return { valid: false, reason: `Risk ${riskPct.toFixed(2)}% exceeds maximum 5%` };
  }

  if (riskPct < 0.05) {
    logger.warn({ symbol: signal.symbol, riskPct }, "WARNING: Risk percentage too low");
    return { valid: false, reason: `Risk ${riskPct.toFixed(4)}% is below minimum 0.05%` };
  }

  return { valid: true, reason: "Stop loss and take profit levels OK" };
}

function validateRiskReward(signal: Signal): ValidationResult {
  if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") {
    return { valid: true, reason: "Not an active trade signal" };
  }

  const rrMatch = signal.riskReward.match(/1:\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!rrMatch) {
    logger.error({ symbol: signal.symbol, riskReward: signal.riskReward }, "CRITICAL: Could not parse risk/reward ratio");
    return { valid: false, reason: `Invalid risk/reward format: ${signal.riskReward}` };
  }

  const rrValue = Number(rrMatch[1]);
  if (rrValue < 1.5) {
    logger.error({ symbol: signal.symbol, rrValue }, "CRITICAL: Risk/reward below minimum 1:1.5");
    return { valid: false, reason: `Risk/reward 1:${rrValue.toFixed(1)} is below minimum 1:1.5` };
  }

  return { valid: true, reason: "Risk/reward OK" };
}

function validatePositionSizing(signal: Signal): ValidationResult {
  if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") {
    return { valid: true, reason: "Not an active trade signal" };
  }

  if (signal.mode !== "futures") {
    return { valid: true, reason: "Spot mode - no position sizing required" };
  }

  const ps = signal.positionSizing;
  if (!ps) {
    if (signal.entryStatus === "ENTER_NOW") {
      logger.error({ symbol: signal.symbol }, "CRITICAL: ENTER_NOW signal without position sizing");
      return { valid: false, reason: "Enter signal missing position sizing data" };
    }
    return { valid: true, reason: "Non-entry signal - position sizing optional" };
  }

  if (ps.positionSizeUsdt <= 0) {
    logger.error({ symbol: signal.symbol, positionSizeUsdt: ps.positionSizeUsdt }, "CRITICAL: Zero position size");
    return { valid: false, reason: "Position size is zero or negative" };
  }

  if (ps.quantity <= 0) {
    logger.error({ symbol: signal.symbol, quantity: ps.quantity }, "CRITICAL: Zero quantity");
    return { valid: false, reason: "Quantity is zero or negative" };
  }

  if (ps.marginUsdt <= 0) {
    logger.error({ symbol: signal.symbol, marginUsdt: ps.marginUsdt }, "CRITICAL: Zero margin");
    return { valid: false, reason: "Margin is zero or negative" };
  }

  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const expectedQty = ps.positionSizeUsdt / avgEntry;
  const qtyDiff = Math.abs(ps.quantity - expectedQty) / Math.max(expectedQty, 1e-9);
  if (qtyDiff > 0.05) {
    logger.warn({ symbol: signal.symbol, quantity: ps.quantity, expectedQty, qtyDiff }, "WARNING: Quantity mismatch with position size");
  }

  return { valid: true, reason: "Position sizing OK" };
}

function validateCriticalConditions(signal: Signal): ValidationResult {
  if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") {
    return { valid: true, reason: "Not an active trade signal" };
  }

  if (signal.entryStatus !== "ENTER_NOW") {
    return { valid: true, reason: "Not an active entry signal" };
  }

  const breakdown = signal.scoreBreakdown ?? {};
  const criticalFilters = [
    { name: "EMA Trend / Execution Alignment", passed: signal.higherTimeframe?.executionAligned ?? false },
    { name: "Momentum Quality", passed: (breakdown.momentumQuality ?? 0) >= 70 },
    { name: "Volume Confirmation", passed: (breakdown.volumeConfirmation ?? 0) >= 65 },
    { name: "Liquidity Sweep", passed: (breakdown.liquiditySweep ?? 0) >= 65 },
    { name: "Entry Sniper", passed: (breakdown.entrySniper ?? 0) >= 70 },
    { name: "Order Book Imbalance", passed: (breakdown.orderBookImbalance ?? 0) >= 60 },
    { name: "BTC Stable", passed: signal.btcStable || signal.symbol === "BTCUSDT" },
    { name: "Risk Reward", passed: (() => { const m = signal.riskReward.match(/1:\s*([0-9]+(?:\.[0-9]+)?)/); return m ? Number(m[1]) >= 2 : false; })() },
    { name: "Fake Breakout Not Risky", passed: !signal.fakeBreakout?.risk },
    { name: "News Risk Not Blocked", passed: !signal.newsRisk?.blocked },
    { name: "Multi-Timeframe Alignment", passed: (breakdown.multiTimeframeAlignment ?? 0) >= 55 },
    { name: "Score Threshold", passed: signal.score >= 92 },
    { name: "Confidence Threshold", passed: signal.confidence >= 60 }
  ];

  const failed = criticalFilters.filter(f => !f.passed);
  if (failed.length > 0) {
    const reason = `Critical filters failed: ${failed.map(f => f.name).join(", ")}`;
    logger.warn({ symbol: signal.symbol, side: signal.side, failed: failed.map(f => f.name) }, reason);
    return { valid: false, reason };
  }

  return { valid: true, reason: "All critical conditions passed" };
}

export function validateSignalDirection(signal: Signal): "LONG" | "SHORT" | "NO_TRADE" {
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const tp1 = signal.takeProfit[0];
  const sl = signal.stopLoss;

  if (tp1 > avgEntry && sl < avgEntry) return "LONG";
  if (tp1 < avgEntry && sl > avgEntry) return "SHORT";
  if (signal.side === "BUY") return "LONG";
  if (signal.side === "WATCHLIST") return "NO_TRADE";
  return signal.side as "LONG" | "SHORT" | "NO_TRADE";
}

export function correctSignalLevels(signal: Signal): Signal {
  if (signal.side !== "LONG" && signal.side !== "SHORT") return signal;

  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  let { stopLoss, takeProfit } = signal;
  const corrected = { ...signal };

  if (signal.side === "LONG") {
    if (stopLoss >= avgEntry) {
      corrected.stopLoss = avgEntry - Math.abs(avgEntry - stopLoss);
      logger.warn({ symbol: signal.symbol, originalSL: stopLoss, correctedSL: corrected.stopLoss }, "Corrected LONG SL from above entry to below entry");
    }
    if (takeProfit[0] <= avgEntry) {
      const risk = Math.abs(avgEntry - corrected.stopLoss);
      corrected.takeProfit = [
        avgEntry + risk * 1.2,
        avgEntry + risk * 2,
        avgEntry + risk * 3
      ] as [number, number, number];
      logger.warn({ symbol: signal.symbol, originalTP: takeProfit, correctedTP: corrected.takeProfit }, "Corrected LONG TP levels to be above entry");
    }
    if (corrected.takeProfit[0] >= corrected.takeProfit[1] || corrected.takeProfit[1] >= corrected.takeProfit[2]) {
      const risk = Math.abs(avgEntry - corrected.stopLoss);
      corrected.takeProfit = [
        avgEntry + risk * 1.2,
        avgEntry + risk * 2,
        avgEntry + risk * 3
      ] as [number, number, number];
    }
  }

  if (signal.side === "SHORT") {
    if (stopLoss <= avgEntry) {
      corrected.stopLoss = avgEntry + Math.abs(stopLoss - avgEntry);
      logger.warn({ symbol: signal.symbol, originalSL: stopLoss, correctedSL: corrected.stopLoss }, "Corrected SHORT SL from below entry to above entry");
    }
    if (takeProfit[0] >= avgEntry) {
      const risk = Math.abs(corrected.stopLoss - avgEntry);
      corrected.takeProfit = [
        avgEntry - risk * 1.2,
        avgEntry - risk * 2,
        avgEntry - risk * 3
      ] as [number, number, number];
      logger.warn({ symbol: signal.symbol, originalTP: takeProfit, correctedTP: corrected.takeProfit }, "Corrected SHORT TP levels to be below entry");
    }
    if (corrected.takeProfit[0] <= corrected.takeProfit[1] || corrected.takeProfit[1] <= corrected.takeProfit[2]) {
      const risk = Math.abs(corrected.stopLoss - avgEntry);
      corrected.takeProfit = [
        avgEntry - risk * 1.2,
        avgEntry - risk * 2,
        avgEntry - risk * 3
      ] as [number, number, number];
    }
  }

  return corrected;
}
