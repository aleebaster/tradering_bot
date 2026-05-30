export type Mode = "LOCAL_ONLY" | "HYBRID" | "OFFLINE_TEST";
export type Side = "LONG" | "SHORT" | "BUY" | "NO_TRADE" | "WATCHLIST";
export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE" | "NEWS_DRIVEN" | "MANIPULATION_RISK";

export interface Candle {
  exchange: "bybit" | "okx" | "binance";
  symbol: string;
  timeframe: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  symbol: string;
  mode: "spot" | "futures";
  candles: Record<string, Candle[]>;
  okxCandles: Record<string, Candle[]>;
  binanceCandles: Record<string, Candle[]>;
  orderBookImbalance: number;
  fundingRate: number;
  openInterestChange: number;
  liquidityScore: number;
  whaleScore: number;
  btcStable: boolean;
  regime: MarketRegime;
}

export interface Signal {
  id: string;
  createdAt: string;
  symbol: string;
  mode: "spot" | "futures";
  side: Side;
  score: number;
  winProbability: number;
  confidence: number;
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage?: string;
  invalidationLevel: number;
  holdTime: string;
  marketRegime: MarketRegime;
  btcStable: boolean;
  reasons: string[];
  rejectionReason: string;
  scoreBreakdown: Record<string, number>;
  management: string;
}

export interface Diagnostics {
  startedAt: string;
  lastScanAt: string | null;
  mode: Mode;
  partialMode: boolean;
  warnings: string[];
  scannedSymbols: number;
  apiStatus: Record<string, string>;
  validSymbols: string[];
  invalidSymbols: string[];
}

export interface BotState {
  diagnostics: Diagnostics;
  marketCondition: string;
  activeSignals: Signal[];
  watchlist: Signal[];
  history: Signal[];
  stats: { signalsToday: number; wins: number; losses: number; winRate: number };
}
