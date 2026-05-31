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
  patterns: Record<string, { wins: number; losses: number }>;
}

const defaults: LearningState = {
  total: 0,
  wins: 0,
  losses: 0,
  fakeBreakouts: 0,
  weights: { smc: 1, macd: 1, volume: 1, orderFlow: 1, liquidity: 1, htf: 1, oi: 1 },
  patterns: {}
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
  rememberPatterns(state, signal, outcome);
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

function rememberPatterns(state: LearningState, signal: Signal, outcome: "TP" | "SL" | "FAKE_BREAKOUT") {
  const won = outcome === "TP";
  for (const pattern of setupPatterns(signal)) {
    const stat = state.patterns[pattern] ?? { wins: 0, losses: 0 };
    if (won) stat.wins += 1;
    else stat.losses += 1;
    state.patterns[pattern] = stat;
  }
  applyPatternBias(state);
}

function setupPatterns(signal: Signal) {
  const patterns: string[] = [];
  if ((signal.scoreBreakdown.momentumQuality ?? 0) >= 55 && (signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) patterns.push("macd_weak_volume");
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65 && signal.btcStable) patterns.push("liquidity_sweep_btc_stable");
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) patterns.push("mtf_alignment");
  if (signal.fakeBreakout.risk) patterns.push("fake_breakout_risk");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") patterns.push("alt_when_btc_unstable");
  return patterns.length ? patterns : ["standard_momentum"];
}

function applyPatternBias(state: LearningState) {
  const weakVolume = state.patterns.macd_weak_volume;
  if (weakVolume && weakVolume.wins + weakVolume.losses >= 5 && weakVolume.losses > weakVolume.wins) {
    state.weights.macd = clampWeight(state.weights.macd - 0.02);
    state.weights.volume = clampWeight(state.weights.volume + 0.02);
  }
  const liquidity = state.patterns.liquidity_sweep_btc_stable;
  if (liquidity && liquidity.wins + liquidity.losses >= 5 && liquidity.wins > liquidity.losses) {
    state.weights.liquidity = clampWeight(state.weights.liquidity + 0.02);
    state.weights.htf = clampWeight(state.weights.htf + 0.01);
  }
  const fake = state.patterns.fake_breakout_risk;
  if (fake && fake.losses >= 3) state.weights.smc = clampWeight(state.weights.smc - 0.02);
}

function load(): LearningState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as LearningState;
    return { ...defaults, ...parsed, weights: { ...defaults.weights, ...(parsed.weights ?? {}) }, patterns: { ...defaults.patterns, ...(parsed.patterns ?? {}) } };
  } catch {
    return { ...defaults, weights: { ...defaults.weights }, patterns: { ...defaults.patterns } };
  }
}

function save(state: LearningState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function clampWeight(value: number) {
  return Math.max(0.75, Math.min(1.25, Math.round(value * 100) / 100));
}
