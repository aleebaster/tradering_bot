import type { IntelligenceBundle } from "./bots";

export type Mode = "LOCAL_ONLY" | "HYBRID" | "OFFLINE_TEST";
export type Side = "LONG" | "SHORT" | "BUY" | "NO_TRADE" | "WATCHLIST";
export type MarketRegime = "TRENDING" | "SIDEWAYS" | "BREAKOUT" | "REVERSAL" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "CHOPPY" | "RANGING" | "EXPANSION" | "COMPRESSION" | "VOLATILE" | "NEWS_DRIVEN" | "MANIPULATION_RISK";
export type SignalGrade = "A+" | "A" | "B" | "C" | "D";

export interface Candle {
  exchange: "bybit" | "okx" | "binance" | "kucoin" | "kraken";
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
  kucoinCandles: Record<string, Candle[]>;
  krakenCandles: Record<string, Candle[]>;
  binanceCandles: Record<string, Candle[]>;
  orderBookImbalance: number;
  fundingRate: number;
  openInterestChange: number;
  liquidityScore: number;
  whaleScore: number;
  btcStable: boolean;
  regime: MarketRegime;
  confirmations: ExchangeConfirmations;
  correlation?: CorrelationContext;
  intelligence?: IntelligenceBundle;
}

export interface CorrelationContext {
  btcDirection: number;
  ethDirection: number;
  total3Direction: number;
  btcDominanceDirection: number;
  dxyDirection: number;
  nasdaqDirection: number;
  aligned: boolean;
  riskOff: boolean;
  details: string[];
}

export interface ExchangeConfirmations {
  bybit: boolean;
  okx: boolean;
  kucoin: boolean;
  kraken: boolean;
  binance: boolean;
  alignedCount: number;
  conflict: boolean;
  details: string[];
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
  grade: SignalGrade;
  expiresAt: string;
  session: AccuracySession;
  newsRisk: AccuracyRisk;
  higherTimeframe: HigherTimeframeBias;
  liquidityIntelligence: LiquidityIntelligence;
  orderFlow: OrderFlowAnalysis;
  openInterestAnalysis: OpenInterestAnalysis;
  fakeBreakout: FakeBreakoutAnalysis;
  fastMoveQuality: FastMoveQuality;
  correlation: CorrelationContext;
  currentPrice: number;
  entryStatus: "ENTER_NOW" | "WAIT_FOR_ENTRY" | "NO_TRADE";
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage?: string;
  positionSizing?: PositionSizing;
  riskReward: string;
  invalidationLevel: number;
  holdTime: string;
  marketRegime: MarketRegime;
  btcStable: boolean;
  confirmations: ExchangeConfirmations;
  intelligence?: IntelligenceBundle;
  reasons: string[];
  rejectionReason: string;
  scoreBreakdown: Record<string, number>;
  tradeManagementActions: string[];
  management: string;
}

export interface AccuracySession {
  name: "LONDON_OPEN" | "NEW_YORK_OPEN" | "LONDON_NY_OVERLAP" | "ASIA_CHOP" | "OFF_HOURS";
  active: boolean;
  confidenceAdjustment: number;
  message: string;
}

export interface AccuracyRisk {
  blocked: boolean;
  severity: "LOW" | "MEDIUM" | "HIGH";
  message: string;
  reasons: string[];
}

export interface HigherTimeframeBias {
  direction: number;
  aligned: boolean;
  executionAligned: boolean;
  counterTrend: boolean;
  confidenceAdjustment: number;
  score: number;
  details: string[];
}

export interface LiquidityIntelligence {
  direction: number;
  score: number;
  sweptAbove: boolean;
  sweptBelow: boolean;
  liquidityPoolAbove: number;
  liquidityPoolBelow: number;
  message: string;
}

export interface OrderFlowAnalysis {
  cvd: number;
  direction: number;
  score: number;
  trapRisk: boolean;
  message: string;
}

export interface OpenInterestAnalysis {
  direction: number;
  score: number;
  message: string;
}

export interface FakeBreakoutAnalysis {
  risk: boolean;
  score: number;
  reasons: string[];
  message: string;
}

export interface FastMoveQuality {
  clean: boolean;
  score: number;
  message: string;
  reasons: string[];
}

export interface PositionSizing {
  balanceUsdt: number;
  marginUsdt: number;
  leverage: "x2" | "x3" | "x5";
  positionSizeUsdt: number;
  quantity: number;
  baseAsset: string;
  entryRange: [number, number];
  averageEntry: number;
  stopLoss: number;
  takeProfit: [number, number, number];
  maxRiskPercent: number;
  accountRiskPercent: number;
  priceRiskPercent: number;
  potentialLossUsdt: number;
  potentialProfitUsdt: [number, number, number];
  liquidationSafety: string;
  liquidationSafetyPercent: number;
  marginMode?: "ISOLATED" | "CROSS";
  riskMode?: "safe" | "aggressive";
  breakevenPlusPrice?: number;
  breakevenPlusOffsetPercent?: number;
  breakevenPlusNetBufferPercent?: number;
  breakevenPlusFeePercent?: number;
  breakevenTrigger?: "TP1";
  breakevenAction?: string;
  breakevenActivationRule?: string;
  breakevenDelay?: string;
  breakevenContinuationMode?: "delay" | "normal" | "tighten";
  antiShakeoutRule?: string;
  profitProtectionMode?: "trail" | "tighten";
  tp1ClosePercent?: number;
  tp2ClosePercent?: number;
  runnerPercent?: number;
  runnerAllowed?: boolean;
  tp2ProtectionAction?: string;
  trailingStopRule?: string;
  runnerTrailingRule?: string;
  runnerAutoKillRule?: string;
  antiGivebackRule?: string;
  maxProfitGivebackPercent?: number;
  trendProtectionRule?: string;
  protectiveStopRequired?: boolean;
  marginProtection?: string;
  entryPlan?: string;
  starterEntryPercent?: number;
  addOnRule?: string;
}

export interface Diagnostics {
  startedAt: string;
  lastScanAt: string | null;
  mode: Mode;
  partialMode: boolean;
  warnings: string[];
  scannedSymbols: number;
  apiStatus: Record<string, string>;
  authErrors: Record<string, string>;
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
  intelligence: { latestBySymbol: Record<string, IntelligenceBundle>; marketReport: IntelligenceBundle["market"] | null; updatedAt: string | null };
}
