import { clamp } from "../indicators";
import type { Candle } from "../types";

export interface SmartMoneyResult {
  whaleScore: number;
  whaleBias: "LONG" | "SHORT" | "NEUTRAL";
  oiScore: number;
  oiDirection: number;
  fundingScore: number;
  fundingDirection: number;
  oiFundingCombined: number;
  bookPressure: number;
  accumulation: boolean;
  distribution: boolean;
  largeTxSignal: boolean;
  reasons: string[];
}

export interface SmartMoneyInput {
  candles: Record<string, Candle[]>;
  orderBookImbalance: number;
  orderBookDepthUsdt: number;
  orderBookSpoofRisk: boolean;
  fundingRate: number;
  openInterestChange: number;
  openInterestAbsolute: number;
  accountRatio: number;
}

export function analyzeSmartMoney(input: SmartMoneyInput): SmartMoneyResult {
  const {
    orderBookImbalance: ob,
    orderBookDepthUsdt: depth,
    orderBookSpoofRisk: spoof,
    fundingRate: fr,
    openInterestChange: oi,
    openInterestAbsolute: oiAbs,
    accountRatio: ar
  } = input;

  const reasons: string[] = [];

  const buyPressure = ob > 0.08;
  const sellPressure = ob < -0.08;
  const obScore = clamp(50 + ob * 150, 0, 100);
  const obDirection = ob > 0.02 ? 1 : ob < -0.02 ? -1 : 0;

  const oiScore = clamp(50 + Math.abs(oi) * 8000, 0, 100);
  const oiDirection = oi > 0.001 ? 1 : oi < -0.001 ? -1 : 0;

  const frScore = clamp(50 - fr * 10000, 0, 100);
  const frDirection = fr > 0.0001 ? -1 : fr < -0.0001 ? 1 : 0;

  const arScore = clamp(50 + ar * 80, 0, 100);
  const arDirection = ar > 0.05 ? 1 : ar < -0.05 ? -1 : 0;

  const accumulation = oi > 0.0015 && buyPressure && ar > 0.05;
  const distribution = oi > 0.0015 && sellPressure && ar < -0.05;

  const oiFundingCombined = clamp(
    (oiDirection > 0 ? 30 : oiDirection < 0 ? -10 : 0) +
    (frDirection > 0 ? 25 : frDirection < 0 ? -15 : 0) +
    (obDirection > 0 ? 20 : obDirection < 0 ? -10 : 0) +
    50,
    0, 100
  );

  const depthScore = depth >= 500_000 ? 100 : depth >= 200_000 ? 80 : depth >= 80_000 ? 60 : depth >= 30_000 ? 40 : 15;
  const largeTxSignal = depth >= 200_000 && Math.abs(ob) > 0.15;

  let whaleScore = clamp(
    obScore * 0.28 +
    oiScore * 0.22 +
    frScore * 0.12 +
    arScore * 0.12 +
    depthScore * 0.1 +
    oiFundingCombined * 0.16 -
    (spoof ? 25 : 0) -
    (depth < 30_000 ? 20 : 0),
    0, 100
  );

  let whaleBias: "LONG" | "SHORT" | "NEUTRAL" = "NEUTRAL";
  if (whaleScore >= 60 && buyPressure) whaleBias = "LONG";
  else if (whaleScore >= 60 && sellPressure) whaleBias = "SHORT";
  else if (accumulation) whaleBias = "LONG";
  else if (distribution) whaleBias = "SHORT";

  if (accumulation) reasons.push("whale accumulation detected");
  if (distribution) reasons.push("whale distribution detected");
  if (Math.abs(ob) > 0.15) reasons.push(`orderbook imbalance ${(ob * 100).toFixed(0)}%`);
  if (Math.abs(oi) > 0.003) reasons.push(`OI spike ${(oi * 100).toFixed(2)}%`);
  if (Math.abs(fr) > 0.0003) reasons.push(`funding ${(fr * 100).toFixed(4)}%`);
  if (spoof) reasons.push("spoof wall risk");
  if (largeTxSignal) reasons.push("large tx absorption pattern");
  if (depth >= 200_000) reasons.push("deep orderbook");

  return {
    whaleScore: Math.round(whaleScore),
    whaleBias,
    oiScore: Math.round(oiScore),
    oiDirection,
    fundingScore: Math.round(frScore),
    fundingDirection: frDirection,
    oiFundingCombined: Math.round(oiFundingCombined),
    bookPressure: obDirection,
    accumulation,
    distribution,
    largeTxSignal,
    reasons
  };
}
