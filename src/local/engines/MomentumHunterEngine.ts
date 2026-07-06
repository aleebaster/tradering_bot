import { clamp } from "../indicators";
import type { Candle, MarketRegime } from "../types";
import { analyzeMomentumFactors, DEFAULT_WEIGHTS, type AdaptiveWeights, type MomentumDetectorResult } from "./MomentumDetector";
import { analyzeSmartMoney, type SmartMoneyInput, type SmartMoneyResult } from "./SmartMoneyAnalyzer";

export interface MomentumHunterInput {
  symbol: string;
  candles: Record<string, Candle[]>;
  orderBookImbalance: number;
  orderBookDepthUsdt: number;
  orderBookSpoofRisk: boolean;
  fundingRate: number;
  openInterestChange: number;
  openInterestAbsolute: number;
  accountRatio: number;
  liquidityScore: number;
  regime: MarketRegime;
}

export interface MomentumHunterOutput {
  pumpProbability: number;
  momentumScore: number;
  smartMoneyScore: number;
  whaleBias: "LONG" | "SHORT" | "NEUTRAL";
  liquidityScore: number;
  orderBookScore: number;
  oiFundingScore: number;
  multiTimeframeAlignment: number;
  entryTiming: "NOW" | "WAIT_RETEST" | "AVOID";
  direction: 1 | -1 | 0;
  decision: "ENTER" | "WATCH" | "SKIP";
  decisionReason: string;
  momentumDetail: MomentumDetectorResult;
  smartMoneyDetail: SmartMoneyResult;
  breakdown: Record<string, number>;
  reasons: string[];
}

const ENTRY_AFTER_PCT = 2.5;

function mtfAlignment(candles: Record<string, Candle[]>, direction: 1 | -1 | 0): number {
  const tfs: Array<[string, string]> = [["1", "1m"], ["3", "3m"], ["5", "5m"], ["15", "15m"], ["60", "1h"]];
  let aligned = 0;
  let total = 0;
  for (const [tf, _name] of tfs) {
    const c = candles[tf];
    if (!c || c.length < 10) continue;
    total++;
    const closes = c.map((x) => x.close);
    const last = closes.at(-1)!;
    const prev = closes.at(-5)!;
    const move = (last - prev) / prev;
    if (Math.sign(move) === direction) aligned++;
  }
  return total > 0 ? Math.round(aligned / total * 100) : 0;
}

function computePumpProbability(
  momentum: number,
  smartMoney: number,
  mtf: number,
  liqScore: number,
  obScore: number,
  oiFunding: number,
  direction: 1 | -1 | 0,
  momentumDetail: MomentumDetectorResult
): number {
  if (direction === 0) return clamp(momentum * 0.3 + smartMoney * 0.25 + mtf * 0.2 + liqScore * 0.15 + obScore * 0.1, 0, 100);

  const momContrib = momentum * 0.22;
  const smContrib = smartMoney * 0.20;
  const mtfContrib = mtf * 0.18;
  const liqContrib = liqScore * 0.14;
  const obContrib = obScore * 0.12;
  const oiContrib = oiFunding * 0.14;

  const volFactor = clamp(momentumDetail.factors.volumeExpansion / 100, 0, 1) * 15;
  const accelFactor = clamp(momentumDetail.factors.priceAcceleration / 100, 0, 1) * 10;
  const veloFactor = clamp(momentumDetail.factors.priceVelocity / 100, 0, 1) * 10;

  let probability = momContrib + smContrib + mtfContrib + liqContrib + obContrib + oiContrib + volFactor + accelFactor + veloFactor;

  const accel = momentumDetail.factors.priceAcceleration;
  const velo = momentumDetail.factors.priceVelocity;
  if (accel > 75 && velo > 65 && mtf >= 60) probability *= 1.15;
  if (smartMoney < 40) probability *= 0.85;
  if (obScore < 35) probability *= 0.9;

  return Math.round(clamp(probability, 0, 100));
}

function computeMomentumScore(
  momentum: number,
  mtf: number,
  liqScore: number,
  obScore: number,
  direction: 1 | -1 | 0,
  momentumDetail: MomentumDetectorResult
): number {
  if (direction === 0) return Math.round(momentum * 0.35 + mtf * 0.25 + liqScore * 0.2 + obScore * 0.2);

  const mom = momentum * 0.30;
  const mtfVal = mtf * 0.22;
  const liq = liqScore * 0.15;
  const ob = obScore * 0.13;

  const volSurge = clamp(momentumDetail.factors.volumeExpansion / 100, 0, 1) * 10;
  const accel = clamp(momentumDetail.factors.priceAcceleration / 100, 0, 1) * 10;

  let score = mom + mtfVal + liq + ob + volSurge + accel;

  if (mtf >= 80) score *= 1.08;
  if (momentumDetail.factors.macdExpansion > 70) score *= 1.05;

  return Math.round(clamp(score, 0, 100));
}

export function analyzeMomentumHunter(input: MomentumHunterInput): MomentumHunterOutput {
  const {
    symbol, candles, orderBookImbalance: ob, orderBookDepthUsdt: depth,
    orderBookSpoofRisk: spoof, fundingRate: fr, openInterestChange: oi,
    openInterestAbsolute: oiAbs, accountRatio: ar, liquidityScore: liqScore, regime
  } = input;

  const primary = candles["15"] ?? candles["5"] ?? candles["1"] ?? [];
  const last = primary.at(-1);
  const closes = primary.map((c) => c.close);
  const direction: 1 | -1 | 0 = !last || closes.length < 5 ? 0 : last.close > closes.at(-5)! ? 1 : -1;

  const momResult = analyzeMomentumFactors(candles, direction, DEFAULT_WEIGHTS);

  const smInput: SmartMoneyInput = {
    candles,
    orderBookImbalance: ob,
    orderBookDepthUsdt: depth,
    orderBookSpoofRisk: spoof,
    fundingRate: fr,
    openInterestChange: oi,
    openInterestAbsolute: oiAbs,
    accountRatio: ar
  };
  const smResult = analyzeSmartMoney(smInput);

  const mtf = mtfAlignment(candles, direction);

  const obScore = clamp(50 + ob * 150, 0, 100);
  const depthScore = depth >= 500_000 ? 100 : depth >= 200_000 ? 85 : depth >= 80_000 ? 65 : depth >= 30_000 ? 45 : 20;
  const obCombined = clamp(obScore * 0.55 + depthScore * 0.45 - (spoof ? 30 : 0), 0, 100);

  const pumpProb = computePumpProbability(momResult.compositeMomentum, smResult.whaleScore, mtf, liqScore, obCombined, smResult.oiFundingCombined, direction, momResult);
  const momScore = computeMomentumScore(momResult.compositeMomentum, mtf, liqScore, obCombined, direction, momResult);

  const velo = momResult.factors.priceVelocity;
  const priceMovePct = primary.length >= 3 ? Math.abs((closes.at(-1)! - closes.at(-3)!) / closes.at(-3)! * 100) : 0;
  const alreadyMovedTooMuch = priceMovePct > ENTRY_AFTER_PCT;

  let entryTiming: "NOW" | "WAIT_RETEST" | "AVOID" = "AVOID";
  let decision: "ENTER" | "WATCH" | "SKIP" = "SKIP";
  let decisionReason = "";

  const enterConditions = [
    pumpProb >= 75,
    momScore >= 70,
    smResult.whaleScore >= 55,
    mtf >= 60,
    obCombined >= 50,
    direction !== 0,
    !alreadyMovedTooMuch || smResult.whaleScore >= 75,
    liqScore >= 45
  ];

  const confirmedCount = enterConditions.filter(Boolean).length;
  const totalConditions = enterConditions.length;

  if (confirmedCount >= 6 && pumpProb >= 80 && momScore >= 75 && !alreadyMovedTooMuch) {
    entryTiming = "NOW";
    decision = "ENTER";
    decisionReason = "strong momentum confirmed";
  } else if (confirmedCount >= 5 && pumpProb >= 65) {
    entryTiming = "WAIT_RETEST";
    decision = (confirmedCount >= 6 && pumpProb >= 70) || pumpProb >= 75 ? "ENTER" : "WATCH";
    decisionReason = alreadyMovedTooMuch ? "already moved, wait retest" : "momentum building, monitor";
  } else if (confirmedCount >= 4 && pumpProb >= 60) {
    entryTiming = "WAIT_RETEST";
    decision = "WATCH";
    decisionReason = "partial confirmation, watchlist";
  } else {
    decisionReason = confirmedCount < 4 ? "insufficient confirmations" : "weak momentum signal";
  }

  if (alreadyMovedTooMuch && confirmedCount < 7) {
    decision = "WATCH";
    decisionReason = `price already moved ${priceMovePct.toFixed(1)}%, need stronger confirmation`;
  }

  if (spoof || smResult.whaleScore < 35) {
    if (decision !== "SKIP") {
      decision = "WATCH";
      decisionReason = spoof ? "spoof risk detected" : "strong selling pressure";
    }
  }

  const reasons: string[] = [
    ...momResult.reasons,
    ...smResult.reasons,
    mtf >= 60 ? `MTF alignment ${mtf}%` : `MTF weak ${mtf}%`,
    alreadyMovedTooMuch ? `moved ${priceMovePct.toFixed(1)}% already - caution` : "early stage move",
    liqScore >= 50 ? "liquidity adequate" : "low liquidity"
  ];

  const breakdown: Record<string, number> = {
    priceAcceleration: momResult.factors.priceAcceleration,
    priceVelocity: momResult.factors.priceVelocity,
    rateOfChange: momResult.factors.rateOfChange,
    rawMomentum: momResult.factors.rawMomentum,
    atrExpansion: momResult.factors.atrExpansion,
    volumeExpansion: momResult.factors.volumeExpansion,
    relativeVolume: momResult.factors.relativeVolume,
    macdExpansion: momResult.factors.macdExpansion,
    rsiAcceleration: momResult.factors.rsiAcceleration,
    adxGrowth: momResult.factors.adxGrowth,
    bollingerExpansion: momResult.factors.bollingerExpansion,
    whaleScore: smResult.whaleScore,
    oiScore: smResult.oiScore,
    fundingScore: smResult.fundingScore,
    oiFundingCombined: smResult.oiFundingCombined,
    orderBookScore: obCombined,
    multiTimeframeAlignment: mtf,
    pumpProbability: pumpProb,
    momentumScore: momScore
  };

  return {
    pumpProbability: pumpProb,
    momentumScore: momScore,
    smartMoneyScore: smResult.whaleScore,
    whaleBias: smResult.whaleBias,
    liquidityScore: liqScore,
    orderBookScore: Math.round(obCombined),
    oiFundingScore: smResult.oiFundingCombined,
    multiTimeframeAlignment: mtf,
    entryTiming,
    direction,
    decision,
    decisionReason,
    momentumDetail: momResult,
    smartMoneyDetail: smResult,
    breakdown,
    reasons: reasons.slice(0, 12)
  };
}

export function formatMomentumDashboard(output: MomentumHunterOutput): string {
  const dirIcon = output.direction === 1 ? "🟢" : output.direction === -1 ? "🔴" : "⚪";
  const decisionIcon = output.decision === "ENTER" ? "✅" : output.decision === "WATCH" ? "👁" : "⏸";
  return [
    "========== MOMENTUM HUNTER ==========",
    "",
    `Pump Probability    ${output.pumpProbability}%`,
    `Momentum Score      ${output.momentumScore}`,
    `Whale Score         ${output.smartMoneyScore}`,
    `Liquidity           ${output.liquidityScore}`,
    `Order Book          ${output.orderBookScore}`,
    `OI + Funding        ${output.oiFundingScore}`,
    `MTF Alignment       ${output.multiTimeframeAlignment}%`,
    `Direction           ${dirIcon} ${output.direction === 1 ? "LONG" : output.direction === -1 ? "SHORT" : "NEUTRAL"}`,
    `Whale Bias          ${output.whaleBias}`,
    "",
    `Decision            ${decisionIcon} ${output.decision}`,
    `Entry Timing        ${output.entryTiming}`,
    `Reason              ${output.decisionReason}`,
    ""
  ].join("\n");
}

export function formatMomentumDetail(output: MomentumHunterOutput): string {
  const f = output.momentumDetail.factors;
  return [
    "--- Momentum Factors ---",
    `Price Acceleration  ${f.priceAcceleration}/100`,
    `Price Velocity      ${f.priceVelocity}/100`,
    `Rate of Change      ${f.rateOfChange}/100`,
    `Raw Momentum        ${f.rawMomentum}/100`,
    `ATR Expansion       ${f.atrExpansion}/100`,
    `Volume Expansion    ${f.volumeExpansion}/100`,
    `Relative Volume     ${f.relativeVolume}/100`,
    `Volatility Expand   ${f.volatilityExpansion}/100`,
    `MACD Expansion      ${f.macdExpansion}/100`,
    `RSI Acceleration    ${f.rsiAcceleration}/100`,
    `ADX Growth          ${f.adxGrowth}/100`,
    `Bollinger Expand    ${f.bollingerExpansion}/100`,
    "",
    `--- Smart Money ---`,
    `Whale Score         ${output.smartMoneyDetail.whaleScore}/100`,
    `OI Score            ${output.smartMoneyDetail.oiScore}/100`,
    `Funding Score       ${output.smartMoneyDetail.fundingScore}/100`,
    `OI+Funding Combined ${output.smartMoneyDetail.oiFundingCombined}/100`,
    `Accumulation        ${output.smartMoneyDetail.accumulation}`,
    `Distribution        ${output.smartMoneyDetail.distribution}`,
    ""
  ].join("\n");
}
