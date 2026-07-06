import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";
import { createCandidate, getActiveModel, getCandidateModel, rejectCandidate, activateCandidate, recordPerformance, rollbackToModel } from "./ModelRegistry";

interface ChangeLogEntry {
  parameter: string;
  oldValue: number;
  newValue: number;
  date: string;
  reason: string;
  winRate: number;
  profitFactor: number;
  drawdown: number;
  expectancy: number;
  trades: number;
  backtestPassed: boolean;
  shadowPassed: boolean;
  accepted: boolean;
}

const changeLogPath = path.join(process.cwd(), "data", "parameter-changelog.json");

function loadChangeLog(): ChangeLogEntry[] {
  try {
    return JSON.parse(fs.readFileSync(changeLogPath, "utf8"));
  } catch {
    return [];
  }
}

function saveChangeLog(log: ChangeLogEntry[]): void {
  fs.mkdirSync(path.dirname(changeLogPath), { recursive: true });
  fs.writeFileSync(changeLogPath, JSON.stringify(log, null, 2));
}

function getNested(obj: Record<string, unknown>, path: string): number | null {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" ? current : null;
}

function setNested(obj: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) current[parts[i]] = {};
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function proposeChange(
  parameterPath: string,
  newValue: number,
  reason: string
): { accepted: boolean; error?: string; candidateId?: string } {
  const active = getActiveModel();
  if (!active) return { accepted: false, error: "No active model found" };

  const candidate = getCandidateModel();
  if (candidate) return { accepted: false, error: `Candidate ${candidate.metadata.id} already exists. Reject or accept it first.` };

  const oldValue = getNested(active.parameters as unknown as Record<string, unknown>, parameterPath);
  if (oldValue === null) return { accepted: false, error: `Parameter '${parameterPath}' not found in model` };

  if (oldValue === newValue) return { accepted: false, error: "New value equals old value — no change" };

  const candidateEntry = createCandidate(parameterPath, oldValue, newValue, reason);
  if (!candidateEntry) return { accepted: false, error: "Failed to create candidate" };

  // Apply the change to the candidate
  const params = candidateEntry.parameters as unknown as Record<string, unknown>;
  setNested(params, parameterPath, newValue);

  logger.info({
    parameter: parameterPath,
    oldValue,
    newValue,
    reason,
    candidateId: candidateEntry.metadata.id
  }, "Parameter change proposed");

  return { accepted: true, candidateId: candidateEntry.metadata.id };
}

export async function evaluateCandidate(
  candidateId: string,
  backtestResult: {
    trades: number;
    winRate: number;
    profitFactor: number;
    drawdown: number;
    expectancy: number;
    sharpe: number;
    passed: boolean;
  },
  shadowResult?: {
    trades: number;
    winRate: number;
    profitFactor: number;
    drawdown: number;
    expectancy: number;
    passed: boolean;
  }
): Promise<{ accepted: boolean; reason: string }> {
  const candidate = getCandidateModel();
  if (!candidate || candidate.metadata.id !== candidateId) return { accepted: false, reason: "Candidate not found" };

  recordPerformance(candidateId, {
    trades: backtestResult.trades,
    winRate: backtestResult.winRate,
    profitFactor: backtestResult.profitFactor,
    drawdown: backtestResult.drawdown,
    expectancy: backtestResult.expectancy,
    sharpe: backtestResult.sharpe
  });

  if (!backtestResult.passed) {
    rejectCandidate(candidateId);
    return { accepted: false, reason: "Backtest failed" };
  }

  if (shadowResult && !shadowResult.passed) {
    rejectCandidate(candidateId);
    return { accepted: false, reason: "Shadow test failed" };
  }

  const accepted = activateCandidate(candidateId);

  const log: ChangeLogEntry = {
    parameter: candidate.metadata.changedParameter ?? "unknown",
    oldValue: candidate.metadata.oldValue ?? 0,
    newValue: candidate.metadata.newValue ?? 0,
    date: new Date().toISOString(),
    reason: candidate.metadata.reason,
    winRate: backtestResult.winRate,
    profitFactor: backtestResult.profitFactor,
    drawdown: backtestResult.drawdown,
    expectancy: backtestResult.expectancy,
    trades: backtestResult.trades,
    backtestPassed: backtestResult.passed,
    shadowPassed: shadowResult?.passed ?? false,
    accepted
  };

  const logEntries = loadChangeLog();
  logEntries.unshift(log);
  saveChangeLog(logEntries);

  return {
    accepted,
    reason: accepted ? "Model accepted and activated" : "Failed to activate"
  };
}

export function autoRollbackIfWorse(): boolean {
  const active = getActiveModel();
  if (!active || !active.metadata.performance) return false;

  const perf = active.metadata.performance;
  if (perf.trades < 10) return false;

  const needRollback = perf.winRate < 0.3 || perf.profitFactor < 0.8 || perf.drawdown > 25;

  if (needRollback && active.metadata.parentId) {
    logger.warn({
      modelId: active.metadata.id,
      winRate: perf.winRate,
      profitFactor: perf.profitFactor,
      drawdown: perf.drawdown,
      parentId: active.metadata.parentId
    }, "Auto-rolling back to parent model");
    return rollbackToModel(active.metadata.parentId);
  }

  return false;
}

export function parameterChangeLogText(limit = 10): string {
  const log = loadChangeLog().slice(0, limit);
  if (!log.length) return "No parameter changes recorded yet.";
  const lines: string[] = ["PARAMETER CHANGE LOG"];
  for (const entry of log) {
    const icon = entry.accepted ? "✓" : "✗";
    lines.push(`  ${icon} ${entry.parameter}: ${entry.oldValue} → ${entry.newValue} (${entry.date.slice(0, 10)})`);
    lines.push(`     WR:${(entry.winRate * 100).toFixed(0)}% PF:${entry.profitFactor.toFixed(2)} DD:${entry.drawdown.toFixed(1)}% Reason: ${entry.reason}`);
  }
  return lines.join("\n");
}
