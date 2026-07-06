import { atr, clamp, ema, macd, rsi, supportResistance } from "../indicators";
import type { Candle } from "../types";

export interface MomentumFactorScores {
  priceAcceleration: number;
  priceVelocity: number;
  rateOfChange: number;
  rawMomentum: number;
  atrExpansion: number;
  volumeExpansion: number;
  relativeVolume: number;
  volatilityExpansion: number;
  emaExpansion: number;
  macdExpansion: number;
  rsiAcceleration: number;
  adxGrowth: number;
  bollingerExpansion: number;
}

export interface MomentumDetectorResult {
  factors: MomentumFactorScores;
  compositeMomentum: number;
  direction: 1 | -1 | 0;
  reasons: string[];
}

export interface AdaptiveWeights {
  priceAcceleration: number;
  priceVelocity: number;
  rateOfChange: number;
  rawMomentum: number;
  atrExpansion: number;
  volumeExpansion: number;
  relativeVolume: number;
  volatilityExpansion: number;
  emaExpansion: number;
  macdExpansion: number;
  rsiAcceleration: number;
  adxGrowth: number;
  bollingerExpansion: number;
}

const DEFAULT_WEIGHTS: AdaptiveWeights = {
  priceAcceleration: 1.0,
  priceVelocity: 0.85,
  rateOfChange: 0.7,
  rawMomentum: 0.9,
  atrExpansion: 0.65,
  volumeExpansion: 1.0,
  relativeVolume: 0.75,
  volatilityExpansion: 0.6,
  emaExpansion: 0.8,
  macdExpansion: 0.85,
  rsiAcceleration: 0.55,
  adxGrowth: 0.5,
  bollingerExpansion: 0.55
};

function adx(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 25;
  const tr = (i: number) => Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  const plusDm = (i: number) => candles[i].high - candles[i - 1].high > candles[i - 1].low - candles[i].low ? Math.max(0, candles[i].high - candles[i - 1].high) : 0;
  const minusDm = (i: number) => candles[i - 1].low - candles[i].low > candles[i].high - candles[i - 1].high ? Math.max(0, candles[i - 1].low - candles[i].low) : 0;
  const atrVal = atr(candles.slice(-period - 1), period);
  if (atrVal === 0) return 25;
  const smoothedPlus = candles.slice(-period).reduce((s, _, idx) => s + plusDm(candles.length - period + idx), 0) / period / atrVal * 100;
  const smoothedMinus = candles.slice(-period).reduce((s, _, idx) => s + minusDm(candles.length - period + idx), 0) / period / atrVal * 100;
  const dx = Math.abs(smoothedPlus - smoothedMinus) / Math.max(smoothedPlus + smoothedMinus, 1e-9) * 100;
  return dx;
}

function bollingerWidth(candles: Candle[], period = 20, multiplier = 2): number {
  if (candles.length < period) return 0;
  const closes = candles.map((c) => c.close);
  const e = ema(closes, period).at(-1) ?? closes.at(-1)!;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = e + multiplier * std;
  const lower = e - multiplier * std;
  return (upper - lower) / e;
}

export function analyzeMomentumFactors(
  candles: Record<string, Candle[]>,
  direction: 1 | -1 | 0,
  weights: AdaptiveWeights = DEFAULT_WEIGHTS
): MomentumDetectorResult {
  const m1 = candles["1"] ?? [];
  const m3 = candles["3"] ?? [];
  const m5 = candles["5"] ?? [];
  const m15 = candles["15"] ?? [];

  const primary = m15.length >= 20 ? m15 : m5.length >= 20 ? m5 : m1;
  if (primary.length < 10) {
    return { factors: emptyFactors(), compositeMomentum: 0, direction: 0, reasons: ["insufficient data"] };
  }

  const closes = primary.map((c) => c.close);
  const last = primary.at(-1)!;
  const sign = direction || (closes.length > 1 && closes.at(-1)! > closes.at(-5)! ? 1 : -1);

  const priceVelocity = primary.length >= 3 ? (closes.at(-1)! - closes.at(-3)!) / closes.at(-3)! * 100 : 0;
  const priceAccel = primary.length >= 6 ? (priceVelocity - (closes.at(-3)! - closes.at(-6)!) / closes.at(-6)! * 100) : 0;
  const roc = primary.length >= 10 ? (closes.at(-1)! - closes.at(-10)!) / closes.at(-10)! * 100 : 0;

  const m = macd(closes);
  const macdHist = m.histogram;
  const macdPrev = primary.length >= 20 ? (() => { const prev = macd(closes.slice(0, -1)); return prev.histogram; })() : 0;
  const macdExpanding = macdHist > macdPrev;

  const rsiVal = rsi(closes);
  const rsiPrev = primary.length >= 20 ? rsi(closes.slice(0, -5)) : 50;
  const rsiAccelVal = rsiVal - rsiPrev;

  const atrNow = atr(primary.slice(-14));
  const atrPrev = atr(primary.slice(-28, -14));
  const atrExpand = atrPrev > 0 ? atrNow / atrPrev : 1;

  const volNow = primary.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const volPrev = primary.slice(-13, -3).reduce((s, c) => s + c.volume, 0) / 10;
  const volExpand = volPrev > 0 ? volNow / volPrev : 1;

  const relVol = primary.length >= 24 ? (() => {
    const current = last.volume;
    const avgVol = primary.slice(-24, -1).reduce((s, c) => s + c.volume, 0) / 23;
    return avgVol > 0 ? current / avgVol : 1;
  })() : 1;

  const ema20 = ema(closes, 20).at(-1) ?? last.close;
  const ema50 = ema(closes, 50).at(-1) ?? last.close;
  const emaSpread = ema20 > 0 ? (ema20 - ema50) / ema50 * 100 : 0;
  const emaPrevSpread = primary.length >= 50 ? (() => {
    const prevCloses = closes.slice(0, -1);
    const e20 = ema(prevCloses, 20).at(-1) ?? prevCloses.at(-1)!;
    const e50 = ema(prevCloses, 50).at(-1) ?? prevCloses.at(-1)!;
    return e50 > 0 ? (e20 - e50) / e50 * 100 : 0;
  })() : 0;
  const emaExpanding = emaSpread > emaPrevSpread;

  const adxVal = adx(primary);
  const bollWidth = bollingerWidth(primary);
  const bollPrev = primary.length >= 25 ? bollingerWidth(primary.slice(0, -5)) : bollWidth;
  const bollExp = bollWidth > bollPrev;

  const volExp = atrNow / last.close * 100;
  const volExpPrev = atrPrev / (primary.at(-15)?.close ?? last.close) * 100;
  const volExpanding = volExp > volExpPrev;

  const directional = sign;

  const raw = {
    priceAcceleration: clamp(((priceAccel > 0 ? 1 : -1) * Math.min(100, Math.abs(priceAccel) * 80)) + 50, 0, 100),
    priceVelocity: clamp((directional > 0 ? 1 : -1) * Math.min(100, Math.abs(priceVelocity) * 40) + 50, 0, 100),
    rateOfChange: clamp((directional > 0 ? 1 : -1) * Math.min(100, Math.abs(roc) * 12) + 50, 0, 100),
    rawMomentum: clamp((directional > 0 ? 1 : -1) * (rsiVal > 50 ? 30 : 0) + (m.histogram > 0 ? 30 : m.histogram < -0.5 ? -20 : 0) + 40, 0, 100),
    atrExpansion: clamp((atrExpand - 1) * 100 + 50, 0, 100),
    volumeExpansion: clamp((volExpand - 1) * 60 + 50, 0, 100),
    relativeVolume: clamp((relVol - 1) * 30 + 50, 0, 100),
    volatilityExpansion: clamp((volExp - volExpPrev) * 200 + 50, 0, 100),
    emaExpansion: clamp((emaExpanding ? 30 : -15) + (emaSpread > 0 ? 20 : -10) + 50, 0, 100),
    macdExpansion: clamp((macdExpanding ? 35 : -15) + (macdHist > 0 ? 20 : -10) + 50, 0, 100),
    rsiAcceleration: clamp(rsiAccelVal * 3 + 50, 0, 100),
    adxGrowth: clamp(Math.min(adxVal, 100)),
    bollingerExpansion: clamp((bollExp ? 25 : -10) + Math.min(25, bollWidth * 100) + 50, 0, 100)
  };

  const weightKeys = Object.keys(DEFAULT_WEIGHTS) as (keyof AdaptiveWeights)[];
  const totalWeight = weightKeys.reduce((s, k) => s + weights[k], 0);
  const composite = weightKeys.reduce((s, k) => s + raw[k] * weights[k], 0) / totalWeight;

  const reasons: string[] = [];
  if (priceVelocity > 0.3) reasons.push(`price velocity ${priceVelocity.toFixed(2)}%/bar`);
  if (priceAccel > 0.2) reasons.push(`price accelerating +${priceAccel.toFixed(2)}`);
  if (volExpand > 1.8) reasons.push(`volume surge ${volExpand.toFixed(1)}x`);
  if (relVol > 2) reasons.push(`relative volume ${relVol.toFixed(1)}x`);
  if (atrExpand > 1.3) reasons.push(`ATR expanding ${atrExpand.toFixed(2)}x`);
  if (macdExpanding && macdHist > 0) reasons.push("MACD histogram expanding");
  if (rsiAccelVal > 5) reasons.push(`RSI accelerating +${rsiAccelVal.toFixed(1)}`);
  if (adxVal > 30) reasons.push(`ADX trending ${adxVal.toFixed(0)}`);
  if (emaExpanding && emaSpread > 0) reasons.push("EMA spread widening bullish");
  if (bollExp) reasons.push("Bollinger bands expanding");
  if (roc > 1) reasons.push(`ROC ${roc.toFixed(2)}%`);

  return {
    factors: raw,
    compositeMomentum: Math.round(clamp(composite, 0, 100)),
    direction: directional as 1 | -1 | 0,
    reasons
  };
}

export function emptyFactors(): MomentumFactorScores {
  return {
    priceAcceleration: 50, priceVelocity: 50, rateOfChange: 50, rawMomentum: 50,
    atrExpansion: 50, volumeExpansion: 50, relativeVolume: 50, volatilityExpansion: 50,
    emaExpansion: 50, macdExpansion: 50, rsiAcceleration: 50, adxGrowth: 50, bollingerExpansion: 50
  };
}

export { DEFAULT_WEIGHTS };
export type { AdaptiveWeights as MomentumAdaptiveWeights };
