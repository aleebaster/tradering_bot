import fs from "node:fs";
import path from "node:path";
import type { Signal } from "./types";

export type TradeResult = "TP1" | "TP2" | "TP3" | "SL";

interface TradeMemoryRecord {
  id: string;
  pair: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: string;
  timeframe: string;
  timeframeCombo: string;
  confidence: number;
  score: number;
  indicatorsSnapshot: Record<string, number | string | boolean>;
  marketRegime: string;
  btcCondition: "stable" | "unstable";
  funding: number;
  oi: number;
  volume: number;
  orderbook: number;
  rsi: number;
  macd: number;
  vwap: number;
  emaAlignment: number;
  entryPrecision: number;
  retestQuality: number;
  sniperTriggerType: string;
  result: TradeResult;
  profitPercent: number;
  durationMinutes: number;
  analysis: string[];
  setupType: string;
  openedAt: string;
  closedAt: string;
}

interface TradeMemoryState {
  trades: TradeMemoryRecord[];
  updatedAt: string;
}

const filePath = path.join(process.cwd(), "data", "trade-memory.json");

export function recordTradeMemory(signal: Signal, result: TradeResult, currentPrice: number) {
  const state = loadTradeMemory();
  const existing = state.trades.find((trade) => trade.id === signal.id);
  const next = buildRecord(signal, result, currentPrice);
  if (existing && resultRank(existing.result) >= resultRank(result)) return state;
  if (existing) Object.assign(existing, next);
  else state.trades.unshift(next);
  state.trades = state.trades.slice(0, 500);
  saveTradeMemory(state);
  return state;
}

export function tradeStatsText() {
  const trades = loadTradeMemory().trades;
  const closed = trades.filter((trade) => ["TP1", "TP2", "TP3", "SL"].includes(trade.result));
  const wins = closed.filter((trade) => trade.result.startsWith("TP"));
  const losses = closed.filter((trade) => trade.result === "SL");
  const profit = closed.reduce((sum, trade) => sum + trade.profitPercent, 0);
  const avgConfidence = avg(closed.map((trade) => trade.confidence));
  const avgRr = avg(closed.map((trade) => resultRank(trade.result)));
  return [
    "📊 Торгова статистика",
    "",
    `Угоди: ${closed.length}`,
    `Win rate: ${closed.length ? Math.round(wins.length / closed.length * 100) : 0}%`,
    `Прибуток: ${profit.toFixed(2)}%`,
    `Перемоги: ${wins.length}`,
    `Збитки: ${losses.length}`,
    `Середній RR: ${avgRr.toFixed(2)}R`,
    `Середня впевненість: ${avgConfidence.toFixed(0)}%`,
    "",
    `Найкращий сетап: ${rankBy(closed, "setupType", true)}`,
    `Найкраща пара: ${rankBy(closed, "pair", true)}`,
    `Найгірша пара: ${rankBy(closed, "pair", false)}`,
    `Найкращий timeframe: ${rankBy(closed, "timeframeCombo", true)}`,
    "",
    "Останні 10 угод:",
    ...(closed.slice(0, 10).map((trade) => `${trade.pair} ${trade.direction} ${trade.result} ${trade.profitPercent.toFixed(2)}% · ${trade.confidence}%`))
  ].join("\n");
}

export function performanceText() {
  const trades = loadTradeMemory().trades.filter((trade) => ["TP1", "TP2", "TP3", "SL"].includes(trade.result));
  const setupRows = performanceRows(trades, "setupType");
  const pairRows = performanceRows(trades, "pair");
  const timeframeRows = performanceRows(trades, "timeframeCombo");
  return [
    "📈 Real Strategy Performance",
    "",
    "Mode: SAFE learning / slow adaptation",
    "Limits: small score nudges only, no threshold changes",
    `Real trades: ${trades.length}`,
    "",
    "Setup performance:",
    ...(setupRows.length ? setupRows : ["немає достатньо даних"]),
    "",
    "Pair memory:",
    ...(pairRows.length ? pairRows : ["немає достатньо даних"]),
    "",
    "Timeframe performance:",
    ...(timeframeRows.length ? timeframeRows : ["немає достатньо даних"]),
    "",
    `Entry precision avg: ${avg(trades.map((trade) => trade.entryPrecision ?? 0)).toFixed(0)}%`,
    `Retest quality avg: ${avg(trades.map((trade) => trade.retestQuality ?? 0)).toFixed(0)}%`
  ].join("\n");
}

export function realTradeQualityAdjustment(signal: Signal) {
  const trades = loadTradeMemory().trades.filter((trade) => ["TP1", "TP2", "TP3", "SL"].includes(trade.result));
  if (trades.length < 12) return 0;
  const setup = setupType(signal);
  const timeframe = timeframeCombo(signal);
  const adjustments = [
    groupAdjustment(trades.filter((trade) => trade.setupType === setup), 6, 1.2),
    groupAdjustment(trades.filter((trade) => trade.pair === signal.symbol), 5, 0.9),
    groupAdjustment(trades.filter((trade) => trade.timeframeCombo === timeframe), 8, 0.7)
  ];
  const precision = entryPrecision(signal) >= 80 ? 0.4 : entryPrecision(signal) < 55 ? -0.4 : 0;
  return round(clampScore(adjustments.reduce((sum, value) => sum + value, 0) + precision, -2.5, 2.5));
}

export function loadTradeMemory(): TradeMemoryState {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TradeMemoryState>;
    return { trades: Array.isArray(parsed.trades) ? parsed.trades as TradeMemoryRecord[] : [], updatedAt: parsed.updatedAt ?? new Date().toISOString() };
  } catch {
    return emptyState();
  }
}

function buildRecord(signal: Signal, result: TradeResult, currentPrice: number): TradeMemoryRecord {
  const entry = (signal.entry[0] + signal.entry[1]) / 2;
  const direction = signal.side === "SHORT" ? "SHORT" : "LONG";
  const profitPercent = direction === "LONG" ? (currentPrice - entry) / entry * 100 : (entry - currentPrice) / entry * 100;
  return {
    id: signal.id,
    pair: signal.symbol,
    direction,
    entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    leverage: signal.positionSizing?.leverage ?? signal.leverage ?? "x2",
    timeframe: signal.mode === "futures" ? "15M/5M" : "4H",
    timeframeCombo: timeframeCombo(signal),
    confidence: signal.confidence,
    score: signal.score,
    indicatorsSnapshot: indicatorSnapshot(signal),
    marketRegime: signal.marketRegime,
    btcCondition: signal.btcStable ? "stable" : "unstable",
    funding: signal.scoreBreakdown.fundingConfirmation ?? 0,
    oi: signal.scoreBreakdown.openInterestConfirmation ?? 0,
    volume: signal.scoreBreakdown.volumeConfirmation ?? 0,
    orderbook: signal.scoreBreakdown.orderBookImbalance ?? 0,
    rsi: signal.scoreBreakdown.momentumQuality ?? 0,
    macd: signal.scoreBreakdown.momentumQuality ?? 0,
    vwap: signal.scoreBreakdown.liquidity ?? 0,
    emaAlignment: signal.scoreBreakdown.multiTimeframeAlignment ?? 0,
    entryPrecision: entryPrecision(signal),
    retestQuality: signal.scoreBreakdown.liquiditySweep ?? 0,
    sniperTriggerType: sniperTriggerType(signal),
    result,
    profitPercent: Math.round(profitPercent * 100) / 100,
    durationMinutes: Math.max(0, Math.round((Date.now() - new Date(signal.createdAt).getTime()) / 60000)),
    analysis: postTradeAnalysis(signal, result),
    setupType: setupType(signal),
    openedAt: signal.createdAt,
    closedAt: new Date().toISOString()
  };
}

function indicatorSnapshot(signal: Signal) {
  return {
    volume: signal.scoreBreakdown.volumeConfirmation ?? 0,
    rsiMomentum: signal.scoreBreakdown.momentumQuality ?? 0,
    macdMomentum: signal.scoreBreakdown.momentumQuality ?? 0,
    vwapBias: signal.currentPrice >= (signal.entry[0] + signal.entry[1]) / 2 ? "above_entry" : "below_entry",
    emaAlignment: signal.scoreBreakdown.multiTimeframeAlignment ?? 0,
    liquiditySweep: signal.scoreBreakdown.liquiditySweep ?? 0,
    fakeBreakoutProtection: signal.scoreBreakdown.fakeBreakoutProtection ?? 0,
    orderFlow: signal.scoreBreakdown.cvdOrderFlow ?? 0,
    btcStable: signal.btcStable,
    funding: signal.scoreBreakdown.fundingConfirmation ?? 0,
    oi: signal.scoreBreakdown.openInterestConfirmation ?? 0
  };
}

function postTradeAnalysis(signal: Signal, result: TradeResult) {
  const reasons: string[] = [];
  const won = result.startsWith("TP");
  if (won) {
    if (signal.btcStable) reasons.push("BTC stable supported the trade");
    if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65) reasons.push("liquidity sweep confirmed entry");
    if ((signal.scoreBreakdown.volumeConfirmation ?? 0) >= 65) reasons.push("volume confirmed participation");
    if ((signal.scoreBreakdown.momentumQuality ?? 0) >= 70) reasons.push("momentum confirmed direction");
    if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) reasons.push("15M/5M alignment worked");
  } else {
    if ((signal.scoreBreakdown.momentumQuality ?? 0) < 55) reasons.push("weak momentum");
    if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) reasons.push("low volume");
    if (!signal.btcStable) reasons.push("BTC instability");
    if (signal.fakeBreakout.risk) reasons.push("fake breakout risk");
    if ((signal.scoreBreakdown.liquiditySweep ?? 0) < 55) reasons.push("bad liquidity sweep");
    if (signal.entryStatus === "WAIT_FOR_ENTRY") reasons.push("early entry risk");
  }
  return reasons.length ? reasons : [won ? "clean technical follow-through" : "setup failed without one dominant reason"];
}

function setupType(signal: Signal) {
  if (signal.fakeBreakout.risk) return "fake_breakout_risk";
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65 && signal.btcStable) return "liquidity_sweep_btc_stable";
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67 && (signal.scoreBreakdown.liquiditySweep ?? 0) >= 55) return "breakout_retest";
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65 && (signal.scoreBreakdown.momentumQuality ?? 0) >= 55) return "macd_weak_volume";
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) return "mtf_alignment";
  return "standard_momentum";
}

function timeframeCombo(signal: Signal) {
  if (signal.mode !== "futures") return "4H + 1H";
  if ((signal.scoreBreakdown.higherTimeframeBias ?? 0) >= 65 && (signal.scoreBreakdown.entrySniper ?? 0) >= 70) return "4H + 15M + 5M + 1M";
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) return "1H + 15M + 5M";
  return "15M + 5M";
}

function entryPrecision(signal: Signal) {
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  if (signal.currentPrice >= entryLow && signal.currentPrice <= entryHigh) return 100;
  const center = (entryLow + entryHigh) / 2;
  const distance = Math.abs(signal.currentPrice - center) / Math.max(center, 1e-9) * 100;
  return Math.max(0, Math.round(100 - distance * 20));
}

function sniperTriggerType(signal: Signal) {
  if ((signal.scoreBreakdown.entrySniper ?? 0) >= 95 && (signal.scoreBreakdown.liquiditySweep ?? 0) >= 70) return "1M liquidity sweep retest";
  if ((signal.scoreBreakdown.entrySniper ?? 0) >= 70) return "1M sniper trigger";
  return "no sniper confirmation";
}

function resultRank(result: TradeResult) {
  return result === "TP3" ? 3 : result === "TP2" ? 2 : result === "TP1" ? 1 : -1;
}

function rankBy(trades: TradeMemoryRecord[], key: "pair" | "timeframe" | "timeframeCombo" | "setupType", best: boolean) {
  const grouped = new Map<string, number>();
  for (const trade of trades) grouped.set(trade[key], (grouped.get(trade[key]) ?? 0) + trade.profitPercent);
  const ranked = [...grouped.entries()].sort((a, b) => best ? b[1] - a[1] : a[1] - b[1]).slice(0, 3);
  return ranked.length ? ranked.map(([name, value]) => `${name} ${value.toFixed(2)}%`).join(", ") : "немає даних";
}

function performanceRows(trades: TradeMemoryRecord[], key: "pair" | "timeframeCombo" | "setupType") {
  const grouped = groupStats(trades, key).filter((item) => item.total >= 2).sort((a, b) => b.winRate - a.winRate || b.avgR - a.avgR).slice(0, 5);
  return grouped.map((item) => `${item.name}: ${Math.round(item.winRate * 100)}% WR · ${item.total} trades · avg ${item.avgR.toFixed(2)}R`);
}

function groupAdjustment(trades: TradeMemoryRecord[], minTrades: number, maxImpact: number) {
  if (trades.length < minTrades) return 0;
  const wins = trades.filter((trade) => trade.result.startsWith("TP")).length;
  const winRate = wins / trades.length;
  const avgR = avg(trades.map((trade) => resultRank(trade.result)));
  const edge = (winRate - 0.55) * 1.4 + (avgR - 0.65) * 0.18;
  return clampScore(edge * maxImpact, -maxImpact, maxImpact);
}

function groupStats(trades: TradeMemoryRecord[], key: "pair" | "timeframeCombo" | "setupType") {
  const grouped = new Map<string, TradeMemoryRecord[]>();
  for (const trade of trades) grouped.set(String(trade[key]), [...(grouped.get(String(trade[key])) ?? []), trade]);
  return [...grouped.entries()].map(([name, items]) => ({
    name,
    total: items.length,
    winRate: items.filter((trade) => trade.result.startsWith("TP")).length / items.length,
    avgR: avg(items.map((trade) => resultRank(trade.result)))
  }));
}

function clampScore(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function saveTradeMemory(state: TradeMemoryState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function emptyState(): TradeMemoryState {
  return { trades: [], updatedAt: new Date().toISOString() };
}
