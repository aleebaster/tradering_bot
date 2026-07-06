import type { BotState, Diagnostics, Signal } from "./types";
import type { MomentumHunterOutput } from "./engines/MomentumHunterEngine";
import type { ExitOutput } from "./engines/MomentumExitEngine";
import { config } from "./config";

const diagnostics: Diagnostics = {
  startedAt: new Date().toISOString(),
  lastScanAt: null,
  mode: config.mode,
  partialMode: config.partialMode,
  warnings: config.warning ? [config.warning] : [],
  scannedSymbols: 0,
  apiStatus: { bybit: "невідомо", okx: config.partialMode ? "частковий режим" : "невідомо", kucoin: "невідомо", binance: "невідомо", telegram: "невідомо" },
  authErrors: {},
  validSymbols: [],
  invalidSymbols: []
};

export const state: BotState = {
  diagnostics,
  marketCondition: "Ініціалізація live-сканера",
  activeSignals: [],
  watchlist: [],
  history: [],
  stats: { signalsToday: 0, wins: 0, losses: 0, winRate: 0 },
  intelligence: { latestBySymbol: {}, marketReport: null, updatedAt: null },
  momentum: { latestBySymbol: {}, updatedAt: null, activeExits: {} }
};

export function recordMomentum(symbol: string, output: MomentumHunterOutput) {
  state.momentum.latestBySymbol[symbol] = output;
  state.momentum.updatedAt = new Date().toISOString();
}

export function recordMomentumExit(symbol: string, output: ExitOutput) {
  state.momentum.activeExits[symbol] = { output, updatedAt: new Date().toISOString() };
}

export function recordSignal(signal: Signal) {
  state.history = [signal, ...state.history].slice(0, 300);
  if (signal.mode === "futures" && signal.score >= 72 && signal.side === "WATCHLIST") state.watchlist = upsertSignal(state.watchlist, signal).slice(0, 30);
  if (signal.side !== "NO_TRADE" && signal.side !== "WATCHLIST") {
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = state.activeSignals.filter((s) => s.createdAt.startsWith(today)).length;
    if (sentToday < config.maxSignalsPerDay) state.activeSignals = [signal, ...state.activeSignals].slice(0, 12);
  }
  state.stats.signalsToday = state.activeSignals.filter((s) => s.createdAt.startsWith(new Date().toISOString().slice(0, 10))).length;
}

function upsertSignal(list: Signal[], signal: Signal) {
  return [signal, ...list.filter((x) => !(x.symbol === signal.symbol && x.mode === signal.mode))];
}
