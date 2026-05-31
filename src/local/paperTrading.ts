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

type PaperState = {
  enabled: boolean;
  trades: PaperTrade[];
  updatedAt: string;
};

const filePath = path.resolve(process.cwd(), "data", "paper-trading.json");

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
  const entry = (signal.entry[0] + signal.entry[1]) / 2;
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

function save(state: PaperState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function emptyState(): PaperState {
  return { enabled: false, trades: [], updatedAt: new Date().toISOString() };
}
