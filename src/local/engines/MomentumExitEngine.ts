import { clamp, atr, ema, rsi, macd } from "../indicators";
import type { Candle } from "../types";

export interface ExitInput {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  direction: 1 | -1;
  positionPnl: number;
  positionPnlPct: number;
  candles: Record<string, Candle[]>;
  openInterestChange: number;
  fundingRate: number;
  volume: number;
  avgVolume: number;
  orderBookImbalance: number;
  holdTimeMinutes: number;
}

export interface ExitOutput {
  pumpExhaustion: number;
  momentumAlive: boolean;
  recommendation: "HOLD" | "EXIT" | "TRAIL";
  trailingStopDistance: number;
  dynamicStopPrice: number;
  reason: string;
  factors: ExitFactors;
}

export interface ExitFactors {
  volumeFade: number;
  momentumFade: number;
  deltaDivergence: number;
  orderBookExhaustion: number;
  atrPosition: number;
  rsiExhaustion: number;
  macdDivergence: number;
  oiDivergence: number;
  fundingExhaustion: number;
  priceSlowdown: number;
}

function computeExitFactors(input: ExitInput): ExitFactors {
  const { candles, direction, entryPrice, currentPrice, openInterestChange: oi, fundingRate: fr, orderBookImbalance: ob } = input;

  const primary = candles["5"] ?? candles["15"] ?? [];
  const closes = primary.map((c) => c.close);
  const last = primary.at(-1);

  const priceMove = entryPrice > 0 ? Math.abs(currentPrice - entryPrice) / entryPrice * 100 : 0;

  const veloNow = primary.length >= 3 ? Math.abs((closes.at(-1)! - closes.at(-3)!) / closes.at(-3)! * 100) : 0;
  const veloPrev = primary.length >= 8 ? Math.abs((closes.at(-4)! - closes.at(-8)!) / closes.at(-8)! * 100) : veloNow;
  const priceSlowdown = veloNow < veloPrev * 0.7 ? clamp((1 - veloNow / Math.max(veloPrev, 0.001)) * 80, 0, 100) : clamp(Math.min(30, (1 - veloNow / Math.max(veloPrev, 0.001)) * 50), 0, 100);

  const volNow = primary.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
  const volPrev = primary.slice(-13, -3).reduce((s, c) => s + c.volume, 0) / 10;
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;
  const volumeFade = volRatio < 0.7 ? clamp((1 - volRatio / 0.7) * 80, 0, 100) : volRatio < 1 ? clamp((1 - volRatio) * 40, 0, 100) : 0;

  const m = macd(closes);
  const mPrev = primary.length >= 12 ? (() => { const prev = macd(closes.slice(0, -3)); return prev; })() : m;
  const macdFading = Math.abs(m.histogram) < Math.abs(mPrev.histogram) * 0.8;
  const macdDivergence = direction === 1
    ? m.histogram < 0 && last && last.close > entryPrice ? 70 : macdFading ? 45 : 10
    : m.histogram > 0 && last && last.close < entryPrice ? 70 : macdFading ? 45 : 10;
  const macdExhaustion = clamp(macdDivergence, 0, 100);

  const rsiVal = rsi(closes);
  const rsiExhaustion = direction === 1
    ? clamp((rsiVal - 70) * 3.3, 0, 100)
    : clamp((30 - rsiVal) * 3.3, 0, 100);

  const momentumFade = clamp(priceSlowdown * 0.35 + volumeFade * 0.35 + macdExhaustion * 0.3, 0, 100);

  const oiDivergence = direction === 1
    ? oi < -0.002 ? 80 : oi < 0 ? 40 : 15
    : oi > 0.002 ? 80 : oi > 0 ? 40 : 15;

  const fundingExhaustion = direction === 1
    ? fr > 0.0005 ? 70 : fr > 0.0002 ? 40 : 10
    : fr < -0.0005 ? 70 : fr < -0.0002 ? 40 : 10;

  const obExhaustion = direction === 1
    ? ob < -0.1 ? 65 : ob < 0 ? 30 : 10
    : ob > 0.1 ? 65 : ob > 0 ? 30 : 10;

  const atrVal = atr(primary);
  const atrPct = atrVal / Math.max(currentPrice, 1) * 100;
  const atrPosition = priceMove > 0 ? clamp(priceMove / atrPct * 25, 0, 100) : 0;

  const deltaDiv = clamp(volumeFade * 0.4 + obExhaustion * 0.3 + oiDivergence * 0.3, 0, 100);

  return {
    volumeFade: Math.round(volumeFade),
    momentumFade: Math.round(momentumFade),
    deltaDivergence: Math.round(deltaDiv),
    orderBookExhaustion: Math.round(obExhaustion),
    atrPosition: Math.round(atrPosition),
    rsiExhaustion: Math.round(rsiExhaustion),
    macdDivergence: Math.round(macdExhaustion),
    oiDivergence: Math.round(oiDivergence),
    fundingExhaustion: Math.round(fundingExhaustion),
    priceSlowdown: Math.round(priceSlowdown)
  };
}

export function analyzeMomentumExit(input: ExitInput): ExitOutput {
  const factors = computeExitFactors(input);

  const pumpExhaustion = clamp(
    factors.volumeFade * 0.18 +
    factors.momentumFade * 0.18 +
    factors.deltaDivergence * 0.12 +
    factors.orderBookExhaustion * 0.10 +
    factors.atrPosition * 0.08 +
    factors.rsiExhaustion * 0.10 +
    factors.macdDivergence * 0.08 +
    factors.oiDivergence * 0.08 +
    factors.fundingExhaustion * 0.08,
    0, 100
  );

  const momentumAlive = pumpExhaustion < 45;

  let recommendation: "HOLD" | "EXIT" | "TRAIL";
  let reason: string;

  if (input.positionPnlPct > 0 && pumpExhaustion < 25) {
    recommendation = "HOLD";
    reason = "momentum strong";
  } else if (pumpExhaustion >= 75) {
    recommendation = "EXIT";
    reason = `exhaustion ${pumpExhaustion}%, momentum fading`;
  } else if (pumpExhaustion >= 55) {
    recommendation = "TRAIL";
    reason = `momentum weakening ${pumpExhaustion}%, activate trailing`;
  } else if (input.positionPnlPct > 2 && pumpExhaustion >= 35) {
    recommendation = "TRAIL";
    reason = `partial exhaustion ${pumpExhaustion}%, protect profits`;
  } else {
    recommendation = "HOLD";
    reason = "momentum alive";
  }

  const atrVal = atr(input.candles["5"] ?? input.candles["15"] ?? []);
  const atrPct = atrVal / Math.max(input.currentPrice, 1);

  const baseTrail = atrPct * 100;
  const exhaustionMultiplier = 1 + pumpExhaustion / 100;
  let trailingStopDistance: number;

  if (input.positionPnlPct > 3) {
    trailingStopDistance = Math.max(0.3, Math.min(2.5, baseTrail * 1.2 * exhaustionMultiplier));
  } else if (input.positionPnlPct > 1.5) {
    trailingStopDistance = Math.max(0.5, Math.min(3, baseTrail * 1.5 * exhaustionMultiplier));
  } else if (input.positionPnlPct > 0) {
    trailingStopDistance = Math.max(0.8, Math.min(4, baseTrail * 2));
  } else {
    trailingStopDistance = Math.max(1, Math.min(5, baseTrail * 2.5));
  }

  const dirSign = input.direction === 1 ? -1 : 1;
  const dynamicStopPrice = input.currentPrice * (1 + dirSign * trailingStopDistance / 100);

  return {
    pumpExhaustion: Math.round(pumpExhaustion),
    momentumAlive,
    recommendation,
    trailingStopDistance: Math.round(trailingStopDistance * 100) / 100,
    dynamicStopPrice,
    reason,
    factors
  };
}

export function formatMomentumStatus(input: ExitInput, output: ExitOutput): string {
  const recIcon = output.recommendation === "HOLD" ? "📗" : output.recommendation === "TRAIL" ? "📙" : "📕";
  return [
    "========== MOMENTUM STATUS ==========",
    "",
    `Current Profit      ${input.positionPnl >= 0 ? "+" : ""}${input.positionPnl.toFixed(2)} USDT (${input.positionPnlPct >= 0 ? "+" : ""}${input.positionPnlPct.toFixed(2)}%)`,
    `Hold Time           ${input.holdTimeMinutes} min`,
    `Momentum            ${output.momentumAlive ? "Growing" : "Fading"}`,
    `Pump Exhaustion     ${output.pumpExhaustion}%`,
    `Trailing Stop       ${output.recommendation === "TRAIL" || output.recommendation === "EXIT" ? `${output.trailingStopDistance}%` : "Not Active"}`,
    `Stop Price          ${output.dynamicStopPrice.toFixed(6)}`,
    `Recommendation      ${recIcon} ${output.recommendation}`,
    `Reason              ${output.reason}`,
    "",
    "--- Exhaustion Factors ---",
    `Volume Fade         ${output.factors.volumeFade}/100`,
    `Momentum Fade       ${output.factors.momentumFade}/100`,
    `Delta Divergence    ${output.factors.deltaDivergence}/100`,
    `OB Exhaustion       ${output.factors.orderBookExhaustion}/100`,
    `RSI Exhaustion      ${output.factors.rsiExhaustion}/100`,
    `MACD Divergence     ${output.factors.macdDivergence}/100`,
    `OI Divergence       ${output.factors.oiDivergence}/100`,
    `Funding Exhaustion  ${output.factors.fundingExhaustion}/100`,
    ""
  ].join("\n");
}
