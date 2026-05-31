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
  timeframe: string;
  confidence: number;
  score: number;
  indicatorsSnapshot: Record<string, number | string | boolean>;
  marketRegime: string;
  btcCondition: "stable" | "unstable";
  funding: number;
  oi: number;
  volume: number;
  rsi: number;
  macd: number;
  vwap: number;
  emaAlignment: number;
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
    "📊 Trading Stats",
    "",
    `Trades: ${closed.length}`,
    `Win rate: ${closed.length ? Math.round(wins.length / closed.length * 100) : 0}%`,
    `Profit: ${profit.toFixed(2)}%`,
    `Wins: ${wins.length}`,
    `Losses: ${losses.length}`,
    `Average RR: ${avgRr.toFixed(2)}R`,
    `Average confidence: ${avgConfidence.toFixed(0)}%`,
    "",
    `Best pairs: ${rankBy(closed, "pair", true)}`,
    `Worst pairs: ${rankBy(closed, "pair", false)}`,
    `Best timeframe: ${rankBy(closed, "timeframe", true)}`,
    `Best setup type: ${rankBy(closed, "setupType", true)}`,
    "",
    "Last 30 trades:",
    ...(closed.slice(0, 30).map((trade) => `${trade.pair} ${trade.direction} ${trade.result} ${trade.profitPercent.toFixed(2)}% · ${trade.confidence}%`))
  ].join("\n");
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
    timeframe: signal.mode === "futures" ? "15M/5M" : "4H",
    confidence: signal.confidence,
    score: signal.score,
    indicatorsSnapshot: indicatorSnapshot(signal),
    marketRegime: signal.marketRegime,
    btcCondition: signal.btcStable ? "stable" : "unstable",
    funding: signal.scoreBreakdown.fundingConfirmation ?? 0,
    oi: signal.scoreBreakdown.openInterestConfirmation ?? 0,
    volume: signal.scoreBreakdown.volumeConfirmation ?? 0,
    rsi: signal.scoreBreakdown.momentumQuality ?? 0,
    macd: signal.scoreBreakdown.momentumQuality ?? 0,
    vwap: signal.scoreBreakdown.liquidity ?? 0,
    emaAlignment: signal.scoreBreakdown.multiTimeframeAlignment ?? 0,
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
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65 && signal.btcStable) return "liquidity_sweep_btc_stable";
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65 && (signal.scoreBreakdown.momentumQuality ?? 0) >= 55) return "macd_weak_volume";
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) return "mtf_alignment";
  return "standard_momentum";
}

function resultRank(result: TradeResult) {
  return result === "TP3" ? 3 : result === "TP2" ? 2 : result === "TP1" ? 1 : -1;
}

function rankBy(trades: TradeMemoryRecord[], key: "pair" | "timeframe" | "setupType", best: boolean) {
  const grouped = new Map<string, number>();
  for (const trade of trades) grouped.set(trade[key], (grouped.get(trade[key]) ?? 0) + trade.profitPercent);
  const ranked = [...grouped.entries()].sort((a, b) => best ? b[1] - a[1] : a[1] - b[1]).slice(0, 3);
  return ranked.length ? ranked.map(([name, value]) => `${name} ${value.toFixed(2)}%`).join(", ") : "немає даних";
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
