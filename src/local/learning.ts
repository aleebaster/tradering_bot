import fs from "node:fs";
import path from "node:path";
import type { Signal } from "./types";

const filePath = path.join(process.cwd(), "data", "learning-state.json");

interface LearningState {
  total: number;
  wins: number;
  losses: number;
  fakeBreakouts: number;
  weights: Record<string, number>;
}

const defaults: LearningState = {
  total: 0,
  wins: 0,
  losses: 0,
  fakeBreakouts: 0,
  weights: { smc: 1, macd: 1, volume: 1, orderFlow: 1, liquidity: 1, htf: 1, oi: 1 }
};

export function adaptiveWeights() {
  return load().weights;
}

export function recordLearningOutcome(signal: Signal, outcome: "TP" | "SL" | "FAKE_BREAKOUT") {
  const state = load();
  state.total += 1;
  if (outcome === "TP") state.wins += 1;
  if (outcome === "SL") state.losses += 1;
  if (outcome === "FAKE_BREAKOUT") state.fakeBreakouts += 1;

  adjust(state, signal, outcome);
  save(state);
}

function adjust(state: LearningState, signal: Signal, outcome: "TP" | "SL" | "FAKE_BREAKOUT") {
  const positive = outcome === "TP" ? 0.03 : -0.03;
  if ((signal.scoreBreakdown.smcConfirmation ?? 0) >= 50) state.weights.smc = clampWeight(state.weights.smc + positive);
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) >= 65) state.weights.volume = clampWeight(state.weights.volume + positive);
  if ((signal.scoreBreakdown.cvdOrderFlow ?? 0) >= 65) state.weights.orderFlow = clampWeight(state.weights.orderFlow + positive);
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65) state.weights.liquidity = clampWeight(state.weights.liquidity + positive);
  if ((signal.scoreBreakdown.higherTimeframeBias ?? 0) >= 65) state.weights.htf = clampWeight(state.weights.htf + positive);
  if ((signal.scoreBreakdown.smartOpenInterest ?? 0) >= 65) state.weights.oi = clampWeight(state.weights.oi + positive);
  if (outcome !== "TP" && (signal.scoreBreakdown.momentumQuality ?? 0) >= 55) state.weights.macd = clampWeight(state.weights.macd - 0.02);
}

function load(): LearningState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as LearningState;
    return { ...defaults, ...parsed, weights: { ...defaults.weights, ...(parsed.weights ?? {}) } };
  } catch {
    return { ...defaults, weights: { ...defaults.weights } };
  }
}

function save(state: LearningState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function clampWeight(value: number) {
  return Math.max(0.75, Math.min(1.25, Math.round(value * 100) / 100));
}
