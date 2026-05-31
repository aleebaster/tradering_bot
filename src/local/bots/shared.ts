import { atr, clamp, ema, macd, rsi, supportResistance, volumeProfileScore } from "../indicators";
import type { Candle, MarketRegime } from "../types";

export type DirectionBias = "LONG" | "SHORT" | "NEUTRAL";

export interface IntelligenceInput {
  symbol: string;
  candles: Record<string, Candle[]>;
  orderBook: { spreadPct: number; depthUsdt: number; imbalance: number; spoofRisk: boolean };
  fundingRate: number;
  openInterestChange: number;
  liquidityScore: number;
  btcStable: boolean;
  regime: MarketRegime;
}

export interface PumpDetectorOutput {
  pumpScore: number;
  momentumStrength: number;
  breakoutProbability: number;
  entryTiming: "NOW" | "WAIT_RETEST" | "AVOID";
  direction: DirectionBias;
  fakeBreakoutRisk: number;
  reasons: string[];
}

export interface WhaleTrackerOutput {
  whaleBias: DirectionBias;
  whaleConfidence: number;
  smartMoneyScore: number;
  trapRisk: number;
  accumulation: boolean;
  distribution: boolean;
  reasons: string[];
}

export interface LiqBotOutput {
  liqSignalStrength: number;
  sweepDirection: DirectionBias;
  trapProbability: number;
  entryQuality: number;
  reclaimConfirmed: boolean;
  reasons: string[];
}

export interface MarketReportOutput {
  marketRegime: MarketRegime | "RISK_ON" | "RISK_OFF";
  riskScore: number;
  marketAggression: number;
  btcBias: DirectionBias;
  altcoinStrength: number;
  futuresHeat: number;
  reasons: string[];
}

export interface IntelligenceBundle {
  pump: PumpDetectorOutput;
  whale: WhaleTrackerOutput;
  liq: LiqBotOutput;
  market: MarketReportOutput;
  updatedAt: string;
}

export class TimedCache<T> {
  private store = new Map<string, { expiresAt: number; value: T }>();
  constructor(private ttlMs: number) {}
  get(key: string) {
    const item = this.store.get(key);
    if (!item || item.expiresAt <= Date.now()) return undefined;
    return item.value;
  }
  set(key: string, value: T) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}

export function current(candles: Candle[]) {
  return candles.at(-1);
}

export function volumeSpike(candles: Candle[], lookback = 24) {
  const last = current(candles);
  if (!last || candles.length < lookback + 1) return 0;
  const base = avg(candles.slice(-lookback - 1, -1).map((c) => c.volume));
  return base > 0 ? last.volume / base : 0;
}

export function directionFromCandles(candles: Candle[]): DirectionBias {
  const last = current(candles);
  if (!last || candles.length < 60) return "NEUTRAL";
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20).at(-1) ?? last.close;
  const e50 = ema(closes, 50).at(-1) ?? last.close;
  const m = macd(closes);
  if (last.close > e20 && e20 > e50 && m.histogram >= 0) return "LONG";
  if (last.close < e20 && e20 < e50 && m.histogram <= 0) return "SHORT";
  return "NEUTRAL";
}

export function momentumScore(candles: Candle[], direction: DirectionBias) {
  const last = current(candles);
  if (!last || direction === "NEUTRAL" || candles.length < 35) return 0;
  const closes = candles.map((c) => c.close);
  const m = macd(closes);
  const rs = rsi(closes);
  const signedMacd = direction === "LONG" ? m.histogram : -m.histogram;
  const rsiOk = direction === "LONG" ? rs >= 52 && rs <= 78 : rs <= 48 && rs >= 22;
  const body = Math.abs(last.close - last.open) / Math.max(last.high - last.low, 1e-9);
  return clamp((signedMacd > 0 ? 45 : 20) + (rsiOk ? 25 : 0) + body * 25 + Math.min(15, volumeSpike(candles) * 5));
}

export function breakoutScore(candles: Candle[], direction: DirectionBias) {
  const last = current(candles);
  if (!last || direction === "NEUTRAL" || candles.length < 40) return 0;
  const prior = candles.slice(-40, -2);
  const sr = supportResistance(prior);
  const broke = direction === "LONG" ? last.close > sr.resistance : last.close < sr.support;
  const retest = direction === "LONG" ? last.low <= sr.resistance && last.close > sr.resistance : last.high >= sr.support && last.close < sr.support;
  return clamp((broke ? 45 : 0) + (retest ? 35 : 0) + Math.min(20, volumeSpike(candles) * 8));
}

export function liquiditySweep(candles: Candle[], direction: DirectionBias) {
  const last = current(candles);
  if (!last || direction === "NEUTRAL" || candles.length < 30) return { swept: false, reclaimed: false, score: 0 };
  const prior = candles.slice(-30, -2);
  const low = Math.min(...prior.map((c) => c.low));
  const high = Math.max(...prior.map((c) => c.high));
  const sweptBelow = last.low < low;
  const sweptAbove = last.high > high;
  const reclaimedLong = sweptBelow && last.close > low && last.close > last.open;
  const rejectedShort = sweptAbove && last.close < high && last.close < last.open;
  const ok = direction === "LONG" ? sweptBelow : sweptAbove;
  const reclaimed = direction === "LONG" ? reclaimedLong : rejectedShort;
  return { swept: ok, reclaimed, score: clamp((ok ? 45 : 0) + (reclaimed ? 45 : 0) + Math.min(10, volumeSpike(candles) * 4)) };
}

export function fakeBreakoutRisk(candles: Candle[], direction: DirectionBias, volumeRatio = volumeSpike(candles)) {
  const last = current(candles);
  if (!last || direction === "NEUTRAL" || candles.length < 35) return 35;
  const prior = candles.slice(-35, -2);
  const high = Math.max(...prior.map((c) => c.high));
  const low = Math.min(...prior.map((c) => c.low));
  const range = Math.max(last.high - last.low, 1e-9);
  const upperWick = (last.high - Math.max(last.open, last.close)) / range;
  const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
  const failedLong = last.high > high && last.close < high && upperWick > 0.45;
  const failedShort = last.low < low && last.close > low && lowerWick > 0.45;
  const failed = direction === "LONG" ? failedLong : failedShort;
  return clamp((failed ? 70 : 20) + (volumeRatio < 0.8 ? 15 : 0));
}

export function volatilityExpansion(shortTf: Candle[], htf: Candle[]) {
  if (shortTf.length < 60 || htf.length < 60) return 0;
  const now = atr(shortTf.slice(-20));
  const prev = atr(shortTf.slice(-60, -20));
  const htfVol = atr(htf.slice(-20)) / Math.max(current(htf)?.close ?? 1, 1);
  return clamp((prev > 0 ? now / prev * 45 : 0) + Math.min(40, htfVol * 2200));
}

export function volumeQuality(candles: Candle[]) {
  return volumeProfileScore(candles);
}

export function directionSign(direction: DirectionBias) {
  return direction === "LONG" ? 1 : direction === "SHORT" ? -1 : 0;
}

export function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
