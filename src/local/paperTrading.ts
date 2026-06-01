import fs from "node:fs";
import path from "node:path";
import type { Signal } from "./types";

type PaperTrade = {
  id: string;
  symbol: string;
  side: Signal["side"];
  openedAt: string;
  entry: number;
  stopLoss: number;
  takeProfit: [number, number, number];
  status: "OPEN" | "WIN" | "LOSS" | "CLOSED";
  rr: number;
};

type PaperMemoryTrade = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  setupType: string;
  openedAt: string;
  closedAt?: string;
  entry: number;
  stopLoss: number;
  activeStopLoss: number;
  takeProfit: [number, number, number];
  score: number;
  confidence: number;
  status: "OPEN" | "WIN" | "LOSS" | "BREAKEVEN" | "EXPIRED";
  highestStage: "NONE" | "TP1" | "TP2" | "TP3";
  rr: number;
  pnlPercent: number;
  durationMinutes: number;
};

type PaperState = {
  enabled: boolean;
  trades: PaperTrade[];
  updatedAt: string;
};

type PaperMemoryState = {
  trades: PaperMemoryTrade[];
  updatedAt: string;
};

const filePath = path.resolve(process.cwd(), "data", "paper-trading.json");
const memoryPath = path.resolve(process.cwd(), "data", "paper-trade-memory.json");

export function loadPaperState(): PaperState {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PaperState>;
    return { enabled: Boolean(parsed.enabled), trades: Array.isArray(parsed.trades) ? parsed.trades as PaperTrade[] : [], updatedAt: parsed.updatedAt ?? new Date().toISOString() };
  } catch {
    return emptyState();
  }
}

export function setPaperMode(enabled: boolean) {
  const state = loadPaperState();
  state.enabled = enabled;
  save(state);
  return state;
}

export function recordPaperOpen(signal: Signal) {
  const state = loadPaperState();
  if (!state.enabled || state.trades.some((trade) => trade.id === signal.id)) return state;
  const entry = averageEntry(signal);
  state.trades.unshift({ id: signal.id, symbol: signal.symbol, side: signal.side, openedAt: new Date().toISOString(), entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, status: "OPEN", rr: 0 });
  save(state);
  return state;
}

export function recordPaperClose(signal: Signal, outcome: "WIN" | "LOSS" | "CLOSED", rr: number) {
  const state = loadPaperState();
  if (!state.enabled) return state;
  const trade = state.trades.find((item) => item.id === signal.id);
  if (!trade || trade.status !== "OPEN") return state;
  trade.status = outcome;
  trade.rr = Math.round(rr * 100) / 100;
  save(state);
  return state;
}

export function recordPaperSetup(signal: Signal) {
  if (signal.score < 80 || signal.score > 84 || signal.mode !== "futures") return loadPaperMemory();
  const state = loadPaperMemory();
  if (state.trades.some((trade) => trade.id === signal.id || trade.status === "OPEN" && trade.symbol === signal.symbol && trade.setupType === setupType(signal))) return state;
  const entry = averageEntry(signal);
  state.trades.unshift({
    id: signal.id,
    symbol: signal.symbol,
    direction: potentialDirection(signal),
    setupType: setupType(signal),
    openedAt: new Date().toISOString(),
    entry,
    stopLoss: signal.stopLoss,
    activeStopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    score: signal.score,
    confidence: signal.confidence,
    status: "OPEN",
    highestStage: "NONE",
    rr: 0,
    pnlPercent: 0,
    durationMinutes: 0
  });
  state.trades = state.trades.slice(0, 500);
  savePaperMemory(state);
  return state;
}

export function updatePaperTradeMemory(symbol: string, currentPrice: number) {
  const state = loadPaperMemory();
  let changed = false;
  for (const trade of state.trades.filter((item) => item.status === "OPEN" && item.symbol === symbol)) {
    const result = simulatePaperTrade(trade, currentPrice);
    if (result) {
      Object.assign(trade, result);
      changed = true;
    }
  }
  if (changed) savePaperMemory(state);
  return state;
}

export function forcePaperMemoryClose(signal: Signal, currentPrice: number) {
  recordPaperSetup({ ...signal, side: "WATCHLIST", score: Math.min(84, Math.max(80, signal.score)) });
  return updatePaperTradeMemory(signal.symbol, currentPrice);
}

export function paperStatsText() {
  const state = loadPaperState();
  const closed = state.trades.filter((trade) => trade.status !== "OPEN");
  const wins = closed.filter((trade) => trade.status === "WIN").length;
  const losses = closed.filter((trade) => trade.status === "LOSS").length;
  const rr = closed.reduce((sum, trade) => sum + trade.rr, 0);
  const winRate = closed.length ? Math.round(wins / closed.length * 100) : 0;
  return [
    "🧪 Paper trading",
    "",
    `Режим: ${state.enabled ? "ON" : "OFF"}`,
    `Угод: ${closed.length}`,
    `Win rate: ${winRate}%`,
    `Wins: ${wins}`,
    `Losses: ${losses}`,
    `Net RR: ${rr.toFixed(2)}`,
    `Open: ${state.trades.filter((trade) => trade.status === "OPEN").length}`
  ].join("\n");
}

export function paperMemoryStatsText() {
  const state = loadPaperMemory();
  const closed = state.trades.filter((trade) => trade.status !== "OPEN");
  const wins = closed.filter((trade) => trade.status === "WIN");
  const losses = closed.filter((trade) => trade.status === "LOSS");
  const avgRr = average(closed.map((trade) => trade.rr));
  const watchlistSuccess = closed.length ? Math.round(wins.length / closed.length * 100) : 0;
  return [
    "🧪 Памʼять paper-угод",
    "",
    `Віртуальний winrate: ${closed.length ? Math.round(wins.length / closed.length * 100) : 0}%`,
    `Успішність моніторингу: ${watchlistSuccess}%`,
    `Найкращий тип сетапу: ${rankSetup(closed, true)}`,
    `Найгірший тип сетапу: ${rankSetup(closed, false)}`,
    `Середній RR: ${avgRr.toFixed(2)}R`,
    `Відкриті симуляції: ${state.trades.filter((trade) => trade.status === "OPEN").length}`,
    `Закриті симуляції: ${closed.length}`,
    "",
    "Останні 20 paper-угод:",
    ...(closed.slice(0, 20).map((trade) => `${trade.symbol} ${trade.direction} ${trade.status} ${trade.rr.toFixed(2)}R · ${trade.setupType}`))
  ].join("\n");
}

export function paperSetupConfidenceAdjustment(setupType: string) {
  const closed = loadPaperMemory().trades.filter((trade) => trade.setupType === setupType && trade.status !== "OPEN").slice(0, 5);
  if (closed.length < 3) return 0;
  const wins = closed.filter((trade) => trade.status === "WIN").length;
  const losses = closed.filter((trade) => trade.status === "LOSS").length;
  if (wins >= 3 && losses === 0) return 1.5;
  if (losses >= 3 && wins === 0) return -1.5;
  return 0;
}

function simulatePaperTrade(trade: PaperMemoryTrade, currentPrice: number): Partial<PaperMemoryTrade> | null {
  const long = trade.direction === "LONG";
  const hitSl = long ? currentPrice <= trade.activeStopLoss : currentPrice >= trade.activeStopLoss;
  const hitTp1 = long ? currentPrice >= trade.takeProfit[0] : currentPrice <= trade.takeProfit[0];
  const hitTp2 = long ? currentPrice >= trade.takeProfit[1] : currentPrice <= trade.takeProfit[1];
  const hitTp3 = long ? currentPrice >= trade.takeProfit[2] : currentPrice <= trade.takeProfit[2];
  const durationMinutes = Math.max(0, Math.round((Date.now() - new Date(trade.openedAt).getTime()) / 60000));
  if (hitTp3) return closePaper(trade, currentPrice, "WIN", "TP3", 3, durationMinutes);
  if (hitTp2 && trade.highestStage !== "TP2") return { highestStage: "TP2", activeStopLoss: trade.entry, durationMinutes };
  if (hitTp1 && trade.highestStage === "NONE") return { highestStage: "TP1", activeStopLoss: trade.entry, durationMinutes };
  if (hitSl && trade.highestStage !== "NONE") return closePaper(trade, currentPrice, "BREAKEVEN", trade.highestStage, 0, durationMinutes);
  if (hitSl) return closePaper(trade, currentPrice, "LOSS", "NONE", -1, durationMinutes);
  if (durationMinutes > 360) return closePaper(trade, currentPrice, "EXPIRED", trade.highestStage, trade.highestStage === "TP2" ? 2 : trade.highestStage === "TP1" ? 1 : 0, durationMinutes);
  return { durationMinutes };
}

function closePaper(trade: PaperMemoryTrade, currentPrice: number, status: PaperMemoryTrade["status"], highestStage: PaperMemoryTrade["highestStage"], rr: number, durationMinutes: number) {
  return { status, highestStage, rr, pnlPercent: pnlPercent(trade, currentPrice), durationMinutes, closedAt: new Date().toISOString() };
}

function loadPaperMemory(): PaperMemoryState {
  try {
    if (!fs.existsSync(memoryPath)) return emptyMemory();
    const parsed = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as Partial<PaperMemoryState>;
    return { trades: Array.isArray(parsed.trades) ? parsed.trades as PaperMemoryTrade[] : [], updatedAt: parsed.updatedAt ?? new Date().toISOString() };
  } catch {
    return emptyMemory();
  }
}

function save(state: PaperState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function savePaperMemory(state: PaperMemoryState) {
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(memoryPath, JSON.stringify(state, null, 2));
}

function emptyState(): PaperState {
  return { enabled: false, trades: [], updatedAt: new Date().toISOString() };
}

function emptyMemory(): PaperMemoryState {
  return { trades: [], updatedAt: new Date().toISOString() };
}

function averageEntry(signal: Signal) {
  return (signal.entry[0] + signal.entry[1]) / 2;
}

function potentialDirection(signal: Signal): "LONG" | "SHORT" {
  if (signal.side === "SHORT") return "SHORT";
  if (signal.side === "LONG" || signal.side === "BUY") return "LONG";
  return signal.stopLoss > averageEntry(signal) ? "SHORT" : "LONG";
}

function setupType(signal: Signal) {
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) >= 65 && signal.btcStable) return "liquidity_sweep_btc_stable";
  if ((signal.scoreBreakdown.momentumQuality ?? 0) >= 55 && (signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) return "macd_weak_volume";
  if ((signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 67) return "mtf_alignment";
  if (signal.fakeBreakout.risk) return "fake_breakout_risk";
  return "borderline_standard";
}

function pnlPercent(trade: PaperMemoryTrade, currentPrice: number) {
  const pnl = trade.direction === "LONG" ? (currentPrice - trade.entry) / trade.entry * 100 : (trade.entry - currentPrice) / trade.entry * 100;
  return Math.round(pnl * 100) / 100;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rankSetup(trades: PaperMemoryTrade[], best: boolean) {
  const grouped = new Map<string, number>();
  for (const trade of trades) grouped.set(trade.setupType, (grouped.get(trade.setupType) ?? 0) + trade.rr);
  const ranked = [...grouped.entries()].sort((a, b) => best ? b[1] - a[1] : a[1] - b[1]);
  return ranked[0] ? `${ranked[0][0]} ${ranked[0][1].toFixed(2)}R` : "немає даних";
}
