import fs from "node:fs";
import path from "node:path";
import type { MarketRegime, Signal } from "./types";

const filePath = path.join(process.cwd(), "data", "learning-state.json");
const minTradesToAdapt = 20;
const fullStrengthTrades = 50;
const rollingWindow = 50;
const defaultWeights = { smc: 1, macd: 1, volume: 1, orderFlow: 1, liquidity: 1, htf: 1, oi: 1, btc: 1 };

type WeightKey = keyof typeof defaultWeights;
type Outcome = "TP" | "SL" | "FAKE_BREAKOUT";
type RegimeBucket = "trending" | "sideways" | "high_volatility" | "low_volatility";

interface LearningTrade {
  id: string;
  symbol: string;
  outcome: Outcome;
  tier: "STRONG" | "NORMAL" | "IGNORE";
  impact: number;
  regime: RegimeBucket;
  patterns: string[];
  features: Partial<Record<WeightKey, number>>;
  createdAt: string;
}

interface LearningState {
  total: number;
  wins: number;
  losses: number;
  fakeBreakouts: number;
  weights: Record<WeightKey, number>;
  regimeModifiers: Record<RegimeBucket, Record<WeightKey, number>>;
  patterns: Record<string, { wins: number; losses: number }>;
  trades: LearningTrade[];
}

const defaults: LearningState = {
  total: 0,
  wins: 0,
  losses: 0,
  fakeBreakouts: 0,
  weights: { ...defaultWeights },
  regimeModifiers: emptyRegimeModifiers(),
  patterns: {},
  trades: []
};

export function adaptiveWeights(regime?: MarketRegime) {
  const state = load();
  const bucket = regime ? regimeBucket(regime) : undefined;
  const regimeWeights = bucket ? state.regimeModifiers[bucket] : undefined;
  return Object.fromEntries(Object.entries(state.weights).map(([key, value]) => [key, clampWeight(value * (regimeWeights?.[key as WeightKey] ?? 1))])) as Record<WeightKey, number>;
}

export function recordLearningOutcome(signal: Signal, outcome: Outcome) {
  const state = load();
  const tier = learningTier(signal);
  state.total += 1;
  if (outcome === "TP") state.wins += 1;
  if (outcome === "SL") state.losses += 1;
  if (outcome === "FAKE_BREAKOUT") state.fakeBreakouts += 1;
  state.trades.unshift({
    id: signal.id,
    symbol: signal.symbol,
    outcome,
    tier: tier.tier,
    impact: tier.impact,
    regime: regimeBucket(signal.marketRegime),
    patterns: setupPatterns(signal),
    features: featureScores(signal),
    createdAt: new Date().toISOString()
  });
  state.trades = state.trades.slice(0, 300);
  recomputeSafeLearning(state);
  save(state);
}

export function resetLearning() {
  const state = { ...defaults, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers(), patterns: {}, trades: [] };
  save(state);
  return state;
}

export function learningStatusText() {
  const state = load();
  const best = rankedPattern(state, true);
  const worst = rankedPattern(state, false);
  return [
    "🧠 Learning Mode",
    "",
    "Mode: SAFE / CONTROLLED",
    `Completed trades: ${state.total}`,
    `Adaptation: ${state.total >= minTradesToAdapt ? "ON" : `OFF until ${minTradesToAdapt} trades`}`,
    "Limits: ±10% per rolling 50 trades",
    "Old trades: decay-weighted",
    "Validation: only Tier 1/2 quality setups affect weights",
    "",
    `MACD modifier: ${modifier(state.weights.macd)}`,
    `Volume modifier: ${modifier(state.weights.volume)}`,
    `SMC modifier: ${modifier(state.weights.smc)}`,
    `BTC filter modifier: ${modifier(state.weights.btc)}`,
    "",
    `Best-performing setup: ${best}`,
    `Worst-performing setup: ${worst}`,
    "",
    "Regime modifiers:",
    ...Object.entries(state.regimeModifiers).map(([regime, weights]) => `${regime}: MACD ${modifier(weights.macd)}, VOL ${modifier(weights.volume)}, LIQ ${modifier(weights.liquidity)}`)
  ].join("\n");
}

function recomputeSafeLearning(state: LearningState) {
  state.patterns = patternStats(state.trades);
  state.weights = { ...defaultWeights };
  state.regimeModifiers = emptyRegimeModifiers();
  const validated = state.trades.filter((trade) => (trade.impact ?? 0) > 0);
  if (validated.length < minTradesToAdapt) return;
  const strength = validated.length >= fullStrengthTrades ? 1 : 0.5;
  state.weights = computeWeights(validated.slice(0, rollingWindow), strength);
  for (const regime of Object.keys(state.regimeModifiers) as RegimeBucket[]) {
    const trades = validated.filter((trade) => trade.regime === regime).slice(0, rollingWindow);
    state.regimeModifiers[regime] = trades.length >= minTradesToAdapt ? computeWeights(trades, strength) : { ...defaultWeights };
  }
}

function computeWeights(trades: LearningTrade[], strength: number) {
  const deltas = Object.fromEntries(Object.keys(defaultWeights).map((key) => [key, 0])) as Record<WeightKey, number>;
  const totals = Object.fromEntries(Object.keys(defaultWeights).map((key) => [key, 0])) as Record<WeightKey, number>;
  trades.forEach((trade, index) => {
    const decay = decayFactor(index);
    const direction = trade.outcome === "TP" ? 1 : -1;
    for (const [key, score] of Object.entries(trade.features) as [WeightKey, number][]) {
      if (score <= 0) continue;
      const influence = decay * (trade.impact ?? 0) * (score / 100);
      deltas[key] += direction * influence;
      totals[key] += influence;
    }
  });
  return Object.fromEntries(Object.entries(defaultWeights).map(([rawKey, base]) => {
    const key = rawKey as WeightKey;
    const normalized = totals[key] > 0 ? deltas[key] / totals[key] : 0;
    return [key, clampWeight(base + normalized * 0.1 * strength)];
  })) as Record<WeightKey, number>;
}

function learningTier(signal: Signal): { tier: "STRONG" | "NORMAL" | "IGNORE"; impact: number } {
  const fullConfirmations = fullQualityConfirmation(signal);
  if (signal.score >= 90 && fullConfirmations) return { tier: "STRONG", impact: 1 };
  if (signal.score >= 85 && signal.score < 90 && fullConfirmations) return { tier: "STRONG", impact: 1 };
  if (signal.score >= 85 && signal.score < 90) return { tier: "NORMAL", impact: 0.4 };
  return { tier: "IGNORE", impact: 0 };
}

function fullQualityConfirmation(signal: Signal) {
  const breakdown = signal.scoreBreakdown;
  const mtf = (breakdown.multiTimeframeAlignment ?? 0) >= 67 && (breakdown.executionAlignment ?? 0) >= 100;
  const momentum = (breakdown.momentumQuality ?? 0) >= 70;
  const volume = (breakdown.volumeConfirmation ?? 0) >= 65;
  const fakeBreakoutOk = !signal.fakeBreakout.risk && (breakdown.fakeBreakoutProtection ?? 0) >= 65;
  const microConfirmation = (breakdown.orderBookImbalance ?? 0) >= 60 || (breakdown.liquiditySweep ?? 0) >= 65;
  return mtf && signal.btcStable && momentum && volume && fakeBreakoutOk && microConfirmation;
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

function featureScores(signal: Signal): Partial<Record<WeightKey, number>> {
  return {
    smc: signal.scoreBreakdown.smcConfirmation ?? 0,
    macd: signal.scoreBreakdown.momentumQuality ?? 0,
    volume: signal.scoreBreakdown.volumeConfirmation ?? 0,
    orderFlow: signal.scoreBreakdown.cvdOrderFlow ?? 0,
    liquidity: signal.scoreBreakdown.liquiditySweep ?? 0,
    htf: signal.scoreBreakdown.higherTimeframeBias ?? 0,
    oi: signal.scoreBreakdown.smartOpenInterest ?? 0,
    btc: signal.symbol === "BTCUSDT" || signal.btcStable ? 0 : 100
  };
}

function patternStats(trades: LearningTrade[]) {
  const stats: Record<string, { wins: number; losses: number }> = {};
  trades.forEach((trade, index) => {
    const weight = decayFactor(index);
    for (const pattern of trade.patterns) {
      const stat = stats[pattern] ?? { wins: 0, losses: 0 };
      if (trade.outcome === "TP") stat.wins += weight;
      else stat.losses += weight;
      stats[pattern] = stat;
    }
  });
  return stats;
}

function rankedPattern(state: LearningState, best: boolean) {
  const ranked = Object.entries(state.patterns)
    .filter(([, stat]) => stat.wins + stat.losses >= 3)
    .map(([name, stat]) => ({ name, score: stat.wins - stat.losses, total: stat.wins + stat.losses }))
    .sort((a, b) => best ? b.score - a.score : a.score - b.score);
  const top = ranked[0];
  return top ? `${top.name} (${top.score.toFixed(1)} net / ${top.total.toFixed(1)} weighted)` : "немає даних";
}

function regimeBucket(regime: MarketRegime): RegimeBucket {
  if (regime === "TRENDING" || regime === "BREAKOUT" || regime === "EXPANSION") return "trending";
  if (regime === "SIDEWAYS" || regime === "RANGING" || regime === "CHOPPY") return "sideways";
  if (regime === "HIGH_VOLATILITY" || regime === "VOLATILE" || regime === "NEWS_DRIVEN" || regime === "MANIPULATION_RISK") return "high_volatility";
  return "low_volatility";
}

function decayFactor(index: number) {
  if (index < 30) return 1;
  if (index < 100) return Math.max(0.25, 1 - (index - 30) / 100);
  return 0.15;
}

function load(): LearningState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LearningState>;
    const migrated = { ...defaults, ...parsed, weights: { ...defaultWeights, ...(parsed.weights ?? {}) }, regimeModifiers: { ...emptyRegimeModifiers(), ...(parsed.regimeModifiers ?? {}) }, patterns: parsed.patterns ?? {}, trades: Array.isArray(parsed.trades) ? parsed.trades : [] };
    const safe = { ...migrated, weights: sanitizeWeights(migrated.weights), regimeModifiers: sanitizeRegimes(migrated.regimeModifiers), patterns: patternStats(migrated.trades) };
    if (safe.total < minTradesToAdapt || safe.trades.filter((trade) => (trade.impact ?? 0) > 0).length < minTradesToAdapt) return { ...safe, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers() };
    return safe;
  } catch {
    return { ...defaults, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers(), patterns: {}, trades: [] };
  }
}

function save(state: LearningState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function sanitizeWeights(weights: Record<string, number>) {
  return Object.fromEntries(Object.entries(defaultWeights).map(([key, value]) => [key, clampWeight(weights[key] ?? value)])) as Record<WeightKey, number>;
}

function sanitizeRegimes(regimes: Record<string, Record<string, number>>) {
  const next = emptyRegimeModifiers();
  for (const regime of Object.keys(next) as RegimeBucket[]) next[regime] = sanitizeWeights(regimes[regime] ?? defaultWeights);
  return next;
}

function emptyRegimeModifiers() {
  return {
    trending: { ...defaultWeights },
    sideways: { ...defaultWeights },
    high_volatility: { ...defaultWeights },
    low_volatility: { ...defaultWeights }
  };
}

function clampWeight(value: number) {
  return Math.max(0.9, Math.min(1.1, Math.round(value * 1000) / 1000));
}

function modifier(value: number) {
  const pct = Math.round((value - 1) * 1000) / 10;
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
