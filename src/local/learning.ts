import fs from "node:fs";
import path from "node:path";
import type { MarketRegime, Signal } from "./types";
import { logger } from "./logger";

const filePath = path.join(process.cwd(), "data", "learning-state.json");
const minTradesToAdapt = 20;
const fullStrengthTrades = 50;
const rollingWindow = 50;
const defaultWeights = { smc: 1, macd: 1, volume: 1, orderFlow: 1, liquidity: 1, htf: 1, oi: 1, btc: 1 };

type WeightKey = keyof typeof defaultWeights;
type Outcome = "TP" | "SL" | "FAKE_BREAKOUT";
type RegimeBucket = "trending" | "sideways" | "high_volatility" | "low_volatility";

interface SymbolStats {
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
  avgConfidence: number;
  lastTradeAt: string;
  consecutiveLosses: number;
  confidenceMultiplier: number;
  isPaused: boolean;
  pauseUntil: string | null;
}

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

interface PumpStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  averageGain: number;
  averageDurationMinutes: number;
  averagePumpPct: number;
  maximumPumpPct: number;
  maximumDrawdown: number;
  averageEntryDelayMs: number;
  averageExitDelayMs: number;
  winRate: number;
  profitFactor: number;
  averageSlippage: number;
}

interface PumpTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  direction: "LONG" | "SHORT";
  durationMinutes: number;
  pumpPct: number;
  maxDrawdown: number;
  entryDelayMs: number;
  exitDelayMs: number;
  slippage: number;
  outcome: "WIN" | "LOSS";
  createdAt: string;
  exitedAt: string;
  pumpProbability: number;
  momentumScore: number;
  whaleScore: number;
}

interface LearningState {
  total: number;
  wins: number;
  losses: number;
  fakeBreakouts: number;
  weights: Record<WeightKey, number>;
  regimeModifiers: Record<RegimeBucket, Record<WeightKey, number>>;
  patterns: Record<string, { wins: number; losses: number }>;
  symbolStats: Record<string, SymbolStats>;
  trades: LearningTrade[];
  pump: PumpStats;
  pumpTrades: PumpTrade[];
}

const emptyPumpStats = (): PumpStats => ({
  totalTrades: 0, wins: 0, losses: 0, totalPnl: 0, averageGain: 0, averageDurationMinutes: 0,
  averagePumpPct: 0, maximumPumpPct: 0, maximumDrawdown: 0, averageEntryDelayMs: 0,
  averageExitDelayMs: 0, winRate: 0, profitFactor: 0, averageSlippage: 0
});

const defaults: LearningState = {
  total: 0,
  wins: 0,
  losses: 0,
  fakeBreakouts: 0,
  weights: { ...defaultWeights },
  regimeModifiers: emptyRegimeModifiers(),
  patterns: {},
  symbolStats: {},
  trades: [],
  pump: emptyPumpStats(),
  pumpTrades: []
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

  updateSymbolStats(state, signal, outcome);

  recomputeSafeLearning(state);
  save(state);
}

export function resetLearning() {
  const state = { ...defaults, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers(), patterns: {}, symbolStats: {}, trades: [] };
  save(state);
  return state;
}

export function learningStatusText() {
  const state = load();
  const best = rankedPattern(state, true);
  const worst = rankedPattern(state, false);
  const symbolLines = Object.entries(state.symbolStats)
    .sort(([, a], [, b]) => b.wins + b.losses - (a.wins + a.losses))
    .slice(0, 10)
    .map(([symbol, stats]) => {
      const wr = stats.wins + stats.losses > 0 ? Math.round(stats.wins / (stats.wins + stats.losses) * 100) : 0;
      const status = stats.isPaused ? "PAUSED" : stats.consecutiveLosses >= 3 ? "WARNING" : "ACTIVE";
      const confMult = stats.confidenceMultiplier !== 1 ? ` (conf x${stats.confidenceMultiplier.toFixed(2)})` : "";
      return `  ${symbol}: ${wr}% WR, ${stats.wins}W/${stats.losses}L, ${status}${confMult}`;
    });

  return [
    "Режим навчання",
    "",
    "Режим: БЕЗПЕЧНИЙ / КОНТРОЛЬОВАНИЙ",
    `Завершені угоди: ${state.total}`,
    `Адаптація: ${state.total >= minTradesToAdapt ? "увімкнено" : `вимкнено до ${minTradesToAdapt} угод`}`,
    "Ліміти: ±10% на rolling 50 угод",
    "Старі угоди: з decay-вагою",
    "Валідація: тільки якісні Tier 1/2 сетапи впливають на ваги",
    "",
    `MACD модифікатор: ${modifier(state.weights.macd)}`,
    `Volume модифікатор: ${modifier(state.weights.volume)}`,
    `SMC модифікатор: ${modifier(state.weights.smc)}`,
    `BTC filter модифікатор: ${modifier(state.weights.btc)}`,
    "",
    `Найкращий сетап: ${best}`,
    `Найгірший сетап: ${worst}`,
    "",
    "Модифікатори режимів:",
    ...Object.entries(state.regimeModifiers).map(([regime, weights]) => `${regime}: MACD ${modifier(weights.macd)}, VOL ${modifier(weights.volume)}, LIQ ${modifier(weights.liquidity)}`),
    "",
    "Статистика по символах:",
    ...symbolLines
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
    const migrated = { ...defaults, ...parsed, weights: { ...defaultWeights, ...(parsed.weights ?? {}) }, regimeModifiers: { ...emptyRegimeModifiers(), ...(parsed.regimeModifiers ?? {}) }, patterns: parsed.patterns ?? {}, symbolStats: parsed.symbolStats ?? {}, trades: Array.isArray(parsed.trades) ? parsed.trades : [], pump: { ...emptyPumpStats(), ...(parsed.pump ?? {}) }, pumpTrades: Array.isArray(parsed.pumpTrades) ? parsed.pumpTrades : [] };
    const safe = { ...migrated, weights: sanitizeWeights(migrated.weights), regimeModifiers: sanitizeRegimes(migrated.regimeModifiers), patterns: patternStats(migrated.trades) };
    if (safe.total < minTradesToAdapt || safe.trades.filter((trade) => (trade.impact ?? 0) > 0).length < minTradesToAdapt) return { ...safe, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers() };
    return safe;
  } catch {
    return { ...defaults, weights: { ...defaultWeights }, regimeModifiers: emptyRegimeModifiers(), patterns: {}, symbolStats: {}, trades: [] };
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

function updateSymbolStats(state: LearningState, signal: Signal, outcome: Outcome) {
  const symbol = signal.symbol;
  if (!state.symbolStats[symbol]) {
    state.symbolStats[symbol] = {
      wins: 0,
      losses: 0,
      totalPnl: 0,
      winRate: 0,
      avgConfidence: 0,
      lastTradeAt: new Date().toISOString(),
      consecutiveLosses: 0,
      confidenceMultiplier: 1,
      isPaused: false,
      pauseUntil: null
    };
  }

  const stats = state.symbolStats[symbol];
  const tradeCount = stats.wins + stats.losses;

  if (outcome === "TP") {
    stats.wins += 1;
    stats.consecutiveLosses = 0;
  } else {
    stats.losses += 1;
    stats.consecutiveLosses += 1;
  }

  stats.winRate = stats.wins + stats.losses > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
  stats.avgConfidence = ((stats.avgConfidence * tradeCount) + signal.confidence) / (tradeCount + 1);
  stats.lastTradeAt = new Date().toISOString();

  if (stats.consecutiveLosses >= 3) {
    stats.confidenceMultiplier = Math.max(0.5, stats.confidenceMultiplier - 0.1);
    stats.isPaused = true;
    stats.pauseUntil = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    logger.warn({ symbol, consecutiveLosses: stats.consecutiveLosses, confidenceMultiplier: stats.confidenceMultiplier }, "Symbol paused due to consecutive losses");
  } else if (stats.consecutiveLosses >= 2) {
    stats.confidenceMultiplier = Math.max(0.7, stats.confidenceMultiplier - 0.05);
  }

  if (stats.isPaused && stats.pauseUntil && Date.now() > Date.parse(stats.pauseUntil)) {
    stats.isPaused = false;
    stats.pauseUntil = null;
    logger.info({ symbol }, "Symbol pause expired - resuming");
  }

  if (tradeCount >= 10 && stats.winRate < 0.3) {
    stats.confidenceMultiplier = Math.max(0.5, stats.confidenceMultiplier - 0.15);
    logger.warn({ symbol, winRate: Math.round(stats.winRate * 100), confidenceMultiplier: stats.confidenceMultiplier }, "Low win rate - reducing confidence multiplier");
  }

  if (tradeCount >= 10 && stats.winRate > 0.65) {
    stats.confidenceMultiplier = Math.min(1.2, stats.confidenceMultiplier + 0.05);
  }
}

export function symbolConfidenceMultiplier(symbol: string): number {
  const state = load();
  const stats = state.symbolStats[symbol];
  if (!stats) return 1;
  if (stats.isPaused) return 0;
  return stats.confidenceMultiplier;
}

export function isSymbolPaused(symbol: string): boolean {
  const state = load();
  const stats = state.symbolStats[symbol];
  if (!stats || !stats.isPaused) return false;
  if (stats.pauseUntil && Date.now() > Date.parse(stats.pauseUntil)) {
    stats.isPaused = false;
    stats.pauseUntil = null;
    save(state);
    return false;
  }
  return true;
}

export function symbolStatsText(symbol: string): string {
  const state = load();
  const stats = state.symbolStats[symbol];
  if (!stats) return `${symbol}: немає даних`;
  const wr = stats.wins + stats.losses > 0 ? Math.round(stats.winRate * 100) : 0;
  return [
    `${symbol}:`,
    `  Win rate: ${wr}%`,
    `  Wins: ${stats.wins}`,
    `  Losses: ${stats.losses}`,
    `  Consecutive losses: ${stats.consecutiveLosses}`,
    `  Confidence multiplier: ${stats.confidenceMultiplier.toFixed(2)}x`,
    `  Status: ${stats.isPaused ? "PAUSED" : "ACTIVE"}`,
    stats.pauseUntil ? `  Pause until: ${stats.pauseUntil}` : "",
    `  Last trade: ${stats.lastTradeAt}`
  ].filter(Boolean).join("\n");
}

export function recordPumpOutcome(trade: PumpTrade) {
  const state = load();
  state.pumpTrades.unshift(trade);
  state.pumpTrades = state.pumpTrades.slice(0, 100);
  const wins = state.pumpTrades.filter((t) => t.outcome === "WIN").length;
  const losses = state.pumpTrades.filter((t) => t.outcome === "LOSS").length;
  const total = wins + losses;
  const totalPnl = state.pumpTrades.reduce((s, t) => s + t.pnl, 0);
  const gains = state.pumpTrades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const lossesArr = state.pumpTrades.filter((t) => t.pnl < 0).map((t) => Math.abs(t.pnl));
  const grossProfit = gains.reduce((s, v) => s + v, 0);
  const grossLoss = lossesArr.reduce((s, v) => s + v, 0);
  state.pump = {
    totalTrades: total,
    wins,
    losses,
    totalPnl,
    averageGain: total > 0 ? totalPnl / total : 0,
    averageDurationMinutes: total > 0 ? state.pumpTrades.reduce((s, t) => s + t.durationMinutes, 0) / total : 0,
    averagePumpPct: total > 0 ? state.pumpTrades.reduce((s, t) => s + t.pumpPct, 0) / total : 0,
    maximumPumpPct: Math.max(...state.pumpTrades.map((t) => t.pumpPct), 0),
    maximumDrawdown: Math.max(...state.pumpTrades.map((t) => t.maxDrawdown), 0),
    averageEntryDelayMs: total > 0 ? state.pumpTrades.reduce((s, t) => s + t.entryDelayMs, 0) / total : 0,
    averageExitDelayMs: total > 0 ? state.pumpTrades.reduce((s, t) => s + t.exitDelayMs, 0) / total : 0,
    winRate: total > 0 ? wins / total : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    averageSlippage: total > 0 ? state.pumpTrades.reduce((s, t) => s + t.slippage, 0) / total : 0
  };
  save(state);
}

export function pumpStatsText(): string {
  const state = load();
  const p = state.pump;
  if (!p || !p.totalTrades) return "PUMP MODE: немає даних";
  const pf = p.profitFactor ?? 0;
  return [
    "PUMP MODE СТАТИСТИКА",
    `Всього угод: ${p.totalTrades}`,
    `Win rate: ${(p.winRate * 100).toFixed(1)}%`,
    `Profit factor: ${pf === Infinity ? "∞" : pf.toFixed(2)}`,
    `Сумарний PnL: ${p.totalPnl >= 0 ? "+" : ""}${p.totalPnl.toFixed(2)} USDT`,
    `Середній прибуток: ${p.averageGain.toFixed(2)} USDT`,
    `Середній Pump: ${p.averagePumpPct.toFixed(2)}%`,
    `Максимальний Pump: ${p.maximumPumpPct.toFixed(2)}%`,
    `Максимальний Drawdown: ${p.maximumDrawdown.toFixed(2)}%`,
    `Середній час утримання: ${p.averageDurationMinutes.toFixed(0)} хв`,
    `Середній Entry Delay: ${p.averageEntryDelayMs.toFixed(0)} мс`,
    `Середній Exit Delay: ${p.averageExitDelayMs.toFixed(0)} мс`,
    `Середній Slippage: ${(p.averageSlippage * 100).toFixed(3)}%`
  ].join("\n");
}
