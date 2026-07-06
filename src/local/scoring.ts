import { analyzeSmc } from "./smc";
import { atr, clamp, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "./indicators";
import { calculatePositionSizing } from "./positionSizing";
import { config } from "./config";
import { adaptiveWeights, symbolConfidenceMultiplier, isSymbolPaused } from "./learning";
import { paperSetupConfidenceAdjustment } from "./paperTrading";
import { realTradeQualityAdjustment } from "./tradeMemory";
import { validateTrade, correctSignalLevels, validateSignalDirection } from "./tradeValidator";
import { logger } from "./logger";
import { state } from "./state";
import type { AccuracyRisk, AccuracySession, Candle, CorrelationContext, FakeBreakoutAnalysis, FastMoveQuality, HigherTimeframeBias, LiquidityIntelligence, MarketRegime, MarketSnapshot, OpenInterestAnalysis, OrderFlowAnalysis, Signal, SignalGrade, Side } from "./types";

export function regimeFrom(candles: MarketSnapshot["candles"]): MarketRegime {
  const base = candles["60"] ?? candles["15"] ?? [];
  if (base.length < 80) return "CHOPPY";
  const closes = base.map((c) => c.close);
  const e20 = ema(closes, 20).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const e200 = ema(closes, 200).at(-1) ?? e50;
  const a = atr(base);
  const last = base.at(-1)!;
  const volPct = a / last.close;
  const volumeScore = volumeProfileScore(base);
  const body = Math.abs(last.close - last.open) / Math.max(last.high - last.low, 1e-9);
  const atrNow = atr(base.slice(-20));
  const atrPrev = atr(base.slice(-80, -20));
  const sr = supportResistance(base);
  const rangePct = (sr.resistance - sr.support) / last.close;
  const trendUp = e20 > e50 && e50 > e200;
  const trendDown = e20 < e50 && e50 < e200;
  const closeNearHigh = last.close > sr.resistance - (sr.resistance - sr.support) * 0.12;
  const closeNearLow = last.close < sr.support + (sr.resistance - sr.support) * 0.12;
  const compression = atrPrev > 0 && atrNow / atrPrev < 0.72;
  const expansion = atrPrev > 0 && atrNow / atrPrev > 1.35 && volumeScore > 65;
  const reversal = trendUp && closeNearLow || trendDown && closeNearHigh;
  if (volPct > 0.035 && volumeScore > 85) return "NEWS_DRIVEN";
  if (body < 0.18 && volumeScore > 90) return "CHOPPY";
  if (volPct > 0.025) return "HIGH_VOLATILITY";
  if (expansion && (closeNearHigh || closeNearLow)) return "BREAKOUT";
  if (reversal && volumeScore >= 60) return "REVERSAL";
  if (compression || volPct < 0.006 || rangePct < 0.012) return "LOW_VOLATILITY";
  if (trendUp || trendDown) return "TRENDING";
  if (rangePct < 0.025) return "SIDEWAYS";
  return "CHOPPY";
}

export function btcStable(btc: MarketSnapshot["candles"]): boolean {
  const c = btc["60"] ?? [];
  if (c.length < 60) return false;
  const a = atr(c);
  const last = c.at(-1)!;
  const sr = supportResistance(c);
  const fakeBreak = (last.high > sr.resistance && last.close < sr.resistance) || (last.low < sr.support && last.close > sr.support);
  return a / last.close < 0.022 && !fakeBreak;
}

export function marketThresholdProfile(regime: MarketRegime, btcOk: boolean) {
  const strong = (regime === "TRENDING" || regime === "BREAKOUT" || regime === "EXPANSION" || regime === "REVERSAL") && btcOk;
  const neutral = (regime === "HIGH_VOLATILITY" || regime === "VOLATILE") && btcOk;
  if (strong) return { mode: "Strong Market", aggression: "Active", entry: 82, watch: 76, early: 68 };
  if (neutral) return { mode: "Neutral Market", aggression: "Selective", entry: 88, watch: 80, early: 70 };
  return { mode: "Weak Market", aggression: "Conservative", entry: 94, watch: 84, early: 74 };
}

export function buildSignal(snapshot: MarketSnapshot): Signal {
  if (isSymbolPaused(snapshot.symbol)) {
    logger.info({ symbol: snapshot.symbol }, "Symbol is paused by learning engine - returning NO_TRADE");
    return emptyNoTradeSignal(snapshot);
  }

  const primaryTf = snapshot.mode === "futures" ? "15" : "240";
  const candles = snapshot.candles[primaryTf] ?? [];
  const precisionCandles = snapshot.candles["1"] ?? snapshot.candles["5"] ?? candles;
  const threeMinuteCandles = snapshot.candles["3"] ?? precisionCandles;
  const fiveMinuteCandles = snapshot.candles["5"] ?? candles;
  const oneHourCandles = snapshot.candles["60"] ?? candles;
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1)!;
  const e20 = ema(closes, 20).at(-1) ?? last.close;
  const e50 = ema(closes, 50).at(-1) ?? last.close;
  const e200 = ema(closes, 200).at(-1) ?? e50;
  const m = macd(closes);
  const smc = analyzeSmc(candles);
  const rs = rsi(closes);
  const vw = vwap(candles);
  const a = atr(candles);
  const sr = supportResistance(candles);
  const execution = executionDirection(snapshot.candles, snapshot.mode);
  const trendUp = execution.direction === 1 || e20 > e50 && last.close > e20 || snapshot.regime === "TRENDING" && e20 > e50 && last.close > vw;
  const trendDown = execution.direction === -1 || e20 < e50 && last.close < e20 || snapshot.regime === "TRENDING" && e20 < e50 && last.close < vw;
  const side: Side = snapshot.mode === "spot" ? (trendUp ? "BUY" : "NO_TRADE") : execution.direction === 1 ? "LONG" : execution.direction === -1 ? "SHORT" : trendUp ? "LONG" : trendDown ? "SHORT" : "NO_TRADE";
  const direction = side === "SHORT" ? -1 : side === "NO_TRADE" ? 0 : 1;
  const trendStrength = clamp(Math.abs(e20 - e50) / Math.max(a, 1e-9) * 25);
  const momentum = direction === 1 ? clamp((m.histogram > 0 ? 55 : 35) + (rs > 52 && rs < 72 ? 25 : 0)) : direction === -1 ? clamp((m.histogram < 0 ? 55 : 35) + (rs < 48 && rs > 28 ? 25 : 0)) : 0;
  const mtf = multiTimeframeScore(snapshot, direction);
  const volume = volumeProfileScore(candles);
  const funding = snapshot.mode === "futures" ? clamp(100 - Math.abs(snapshot.fundingRate) * 10000) : 70;
  const oi = clamp(50 + snapshot.openInterestChange * 1000 * direction);
  const orderbook = clamp(50 + snapshot.orderBookImbalance * 120 * direction);
  const session = sessionFilter(new Date(), snapshot);
  const newsRisk = highImpactNewsRisk(snapshot, last, a);
  const htf = higherTimeframeBias(snapshot.candles, direction);
  const liquidity = liquidityIntelligence(candles, direction);
  const orderFlow = orderFlowAnalysis(precisionCandles, direction);
  const oiAnalysis = openInterestAnalysis(snapshot.openInterestChange, last, candles.at(-8), direction);
  const fakeBreakout = fakeBreakoutAnalysis(candles, direction, volume, oiAnalysis, snapshot.btcStable, snapshot.regime);
  const fastMove = fastMoveQuality(precisionCandles, candles, direction, volume, orderFlow, snapshot.regime);
  const correlation = snapshot.correlation ?? neutralCorrelation();
  const learned = adaptiveWeights(snapshot.regime);
  const intel = intelligenceScores(snapshot, direction);
  const marketQuality = marketQualityProfile(snapshot, { trendStrength, momentum, volume, orderbook, fastMoveScore: fastMove.score, fakeBreakoutRisk: fakeBreakout.risk });
  const coinQuality = coinQualityProfile(snapshot, { volume, orderbook, volatilityPct: a / last.close, fakeBreakoutRisk: fakeBreakout.risk });
  const btcRiskPenalty = btcAltRiskPenalty(snapshot, direction, correlation) * learned.btc;
  const regimePenalty = marketQuality.penalty;
  const btcPenalty = (snapshot.symbol === "BTCUSDT" || snapshot.btcStable ? 0 : 24) * learned.btc + btcRiskPenalty;
  const confirmationProfile = adaptiveConfirmationProfile(snapshot, { volume, momentum, liquidityScore: snapshot.liquidityScore, orderbook, fastMoveScore: fastMove.score });
  const confirmationPenalty = confirmationProfile.allowed ? confirmationProfile.penalty : 35;
  const paperAdjustment = paperSetupConfidenceAdjustment(setupTypeFromScores(snapshot, { momentum, volume, mtf, liquiditySweep: liquidity.score }));
  const sniper = entrySniperTrigger(fiveMinuteCandles, bestEntryTimingCandles(precisionCandles, threeMinuteCandles, fiveMinuteCandles, direction), direction, volume);
  const advancedBonus = htf.score * 0.15 * learned.htf + liquidity.score * 0.08 * learned.liquidity + orderFlow.score * 0.1 * learned.orderFlow + oiAnalysis.score * 0.08 * learned.oi + fakeBreakout.score * 0.11 + fastMove.score * 0.08 + (sniper.ready ? 4 : -6) + (correlation.aligned ? 8 : correlation.riskOff ? -18 : 0) + session.confidenceAdjustment + htf.confidenceAdjustment + intel.bonus;
  const weighted = trendStrength * marketQuality.trendWeight + snapshot.liquidityScore * 0.06 + volume * 0.1 * learned.volume + smc.score * 0.13 * learned.smc + mtf * 0.1 + snapshot.whaleScore * 0.04 + funding * 0.05 + oi * 0.04 + momentum * marketQuality.momentumWeight * learned.macd + orderbook * 0.06 + advancedBonus + paperAdjustment - regimePenalty - btcPenalty - coinQuality.penalty - intel.penalty;
  let score = clamp(weighted - confirmationPenalty);
  const weakMomentum = direction !== 0 && momentum < 55;
  const hardBlock = accuracyHardBlock(snapshot, { side, direction, session, newsRisk, htf, liquidity, orderFlow, oiAnalysis, fakeBreakout, fastMove, correlation });
  if (snapshot.regime === "MANIPULATION_RISK" || side === "NO_TRADE") score = Math.min(score, 55);
  if (snapshot.regime === "LOW_VOLATILITY" && !sniper.ready) score = Math.min(score, 84);
  if (snapshot.regime === "SIDEWAYS" && liquidity.score < 65) score = Math.min(score, 84);
  if (coinQuality.tier === "C-TIER" && score < 90) score = Math.min(score, 89);
  if (weakMomentum) score = Math.min(score, 84);
  if (!confirmationProfile.allowed) score = Math.min(score, confirmationProfile.reason === "exchange conflict" ? 79 : 84);
  if (confirmationProfile.smallAltStrict && score < 90) score = Math.min(score, 84);
  if (hardBlock.blocked) score = Math.min(score, hardBlock.maxScore);
  if (intel.hardRisk) score = Math.min(score, 79);
  const levelSide: "LONG" | "SHORT" = side === "SHORT" ? "SHORT" : "LONG";
  const levels = professionalTradeLevels(candles, precisionCandles, oneHourCandles, levelSide, a, sr);
  const entry = levels.entry;
  const stopLoss = levels.stopLoss;
  const takeProfit = levels.takeProfit;
  const avgEntry = (entry[0] + entry[1]) / 2;
  logger.info({ symbol: snapshot.symbol, pipelineStage: "LEVELS_GENERATED", side: levelSide, entry, avgEntry: Math.round(avgEntry * 100) / 100, stopLoss, takeProfit, risk: Math.round(Math.abs(avgEntry - stopLoss) * 100) / 100, rr: Math.abs(avgEntry - stopLoss) > 0 ? Math.round(Math.abs(takeProfit[2] - avgEntry) / Math.abs(avgEntry - stopLoss) * 10) / 10 : 0 }, "DecisionEngine: professionalTradeLevels output");
  const rrValue = riskRewardValue(entry, stopLoss, takeProfit[2], direction);
  if (rrValue < 2) score = Math.min(score, 69);
  score = Math.max(score, earlySetupFloor(snapshot, { side, executionAligned: execution.aligned, htfScore: htf.score, trendStrength, mtf, volume, orderFlowScore: orderFlow.score, liquidityScore: liquidity.score, funding, fakeBreakoutRisk: fakeBreakout.risk, newsBlocked: newsRisk.blocked, rrValue }));
  score = clamp(score + professionalIntelligenceAdjustment(snapshot, intel, { side, rrValue, newsRisk, volume, momentum, sniperReady: sniper.ready, liquidityScore: liquidity.score, fakeBreakoutRisk: fakeBreakout.risk }));
  const roundedScore = Math.round(score);
  const thresholds = marketThresholdProfile(snapshot.regime, snapshot.btcStable);
  const entryThreshold = thresholds.entry;
  const watchThreshold = Math.min(coinQuality.watchThreshold, thresholds.watch);
  const earlyThreshold = thresholds.early;
  const inEntryZone = last.close >= Math.min(...entry) && last.close <= Math.max(...entry);
  const micro = microConfirmationProfile(snapshot, { momentum, volume, orderbook, orderFlowScore: orderFlow.score, liquidityScore: liquidity.score, sniperScore: sniper.score, fastMoveScore: fastMove.score, fakeBreakoutRisk: fakeBreakout.risk, newsBlocked: newsRisk.blocked, rrValue });
  const fastMomentumEntry = (snapshot.regime === "HIGH_VOLATILITY" || snapshot.regime === "VOLATILE" || snapshot.regime === "BREAKOUT" || snapshot.regime === "TRENDING") && fastMove.clean && volume >= 68 && momentum >= 74;
  const intelligenceEntry = intel.entryQuality >= 72 && intel.aligned && !intel.hardRisk;
  const strongEntryReady = roundedScore >= entryThreshold && side !== "NO_TRADE" && inEntryZone && (sniper.ready || micro.weightedScore >= 86 && micro.retestForming) && snapshot.btcStable && volume >= 62 && momentum >= 68 && (liquidity.score >= 65 || fastMomentumEntry || intelligenceEntry || micro.strongOrderflow) && !fakeBreakout.risk && !hardBlock.blocked && !intel.hardRisk && micro.tinyAccountOk;
  const earlyEntryReady = !strongEntryReady && roundedScore >= micro.earlyThreshold && side !== "NO_TRADE" && snapshot.mode === "futures" && micro.ready && !hardBlock.blocked && !intel.hardRisk;
  const qualifiedSide: Side = strongEntryReady ? side : roundedScore >= earlyThreshold && snapshot.mode === "futures" && side !== "NO_TRADE" ? "WATCHLIST" : "NO_TRADE";
  const entryStatus = strongEntryReady ? "ENTER_NOW" : earlyEntryReady ? "EARLY_ENTRY_READY" : qualifiedSide === "WATCHLIST" ? "WAIT_FOR_ENTRY" : "NO_TRADE";
  const riskReward = riskRewardRatio(rrValue);
  const grade = gradeFrom(roundedScore, hardBlock.blocked, qualifiedSide);
  const leverage = snapshot.mode === "futures" && !["NO_TRADE", "WATCHLIST"].includes(qualifiedSide) ? leverageRecommendation(score, a / last.close, momentum, snapshot.regime) : undefined;
  const positionSizing = calculatePositionSizing({
    symbol: snapshot.symbol,
    mode: snapshot.mode,
    side: qualifiedSide,
    score: roundedScore,
    entry,
    stopLoss,
    takeProfit,
    marketRegime: snapshot.regime,
    volatilityPct: a / last.close,
    momentumScore: momentum,
    volumeScore: volume,
    btcStable: snapshot.btcStable,
    orderFlowScore: orderFlow.score,
    sniperConfidence: sniper.score,
    fakeBreakoutRisk: fakeBreakout.risk
  });
  const management = managementText(qualifiedSide, entryStatus);
  const signal: Signal = {
    id: `${snapshot.symbol}-${snapshot.mode}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: snapshot.symbol,
    mode: snapshot.mode,
    side: qualifiedSide,
    score: roundedScore,
    winProbability: Math.round(clamp(score, 0, 94)),
    confidence: Math.round(score),
    grade,
    expiresAt: new Date(Date.now() + signalTtlMs(roundedScore)).toISOString(),
    session,
    newsRisk,
    higherTimeframe: htf,
    liquidityIntelligence: liquidity,
    orderFlow,
    openInterestAnalysis: oiAnalysis,
    fakeBreakout,
    fastMoveQuality: fastMove,
    correlation,
    currentPrice: last.close,
    entryStatus,
    entry,
    stopLoss,
    takeProfit,
    leverage,
    positionSizing,
    riskReward,
    invalidationLevel: stopLoss,
    holdTime: snapshot.mode === "futures" ? "30 хвилин до 6 годин" : "1-7 днів",
    marketRegime: snapshot.regime,
    btcStable: snapshot.btcStable,
    confirmations: snapshot.confirmations,
    intelligence: snapshot.intelligence,
    reasons: reasons(snapshot, { trendStrength, volume, mtf, smc: smc.score, momentum, funding, oi, orderbook, rs }, { session, newsRisk, htf, liquidity, orderFlow, oiAnalysis, fakeBreakout, fastMove, correlation }),
    rejectionReason: rejectionReason(qualifiedSide, roundedScore, snapshot, weakMomentum, rrValue, entryThreshold, hardBlock.reason),
    scoreBreakdown: {
      trendStrength: Math.round(trendStrength),
      liquidity: Math.round(snapshot.liquidityScore),
      volumeConfirmation: Math.round(volume),
      smcConfirmation: Math.round(smc.score),
      multiTimeframeAlignment: Math.round(mtf),
      whaleActivity: Math.round(snapshot.whaleScore),
      fundingConfirmation: Math.round(funding),
      openInterestConfirmation: Math.round(oi),
      momentumQuality: Math.round(momentum),
      orderBookImbalance: Math.round(orderbook),
      higherTimeframeBias: Math.round(htf.score),
      executionAlignment: execution.aligned ? 100 : 0,
      counterTrendPenalty: Math.abs(Math.min(0, htf.confidenceAdjustment)),
      liquiditySweep: Math.round(liquidity.score),
      cvdOrderFlow: Math.round(orderFlow.score),
      smartOpenInterest: Math.round(oiAnalysis.score),
      fakeBreakoutProtection: Math.round(fakeBreakout.score),
      fastMoveQuality: Math.round(fastMove.score),
      entrySniper: sniper.ready ? 100 : Math.max(0, Math.round(sniper.score)),
      sessionQuality: session.confidenceAdjustment,
      regimePenalty: Math.round(regimePenalty),
      marketQuality: Math.round(marketQuality.score),
      coinQuality: coinQuality.tier === "A-TIER" ? 100 : coinQuality.tier === "B-TIER" ? 75 : 50,
      btcPenalty: Math.round(btcPenalty),
      exchangeConfirmationPenalty: Math.round(confirmationPenalty),
      adaptiveConfirmationRequired: entryThreshold,
      marketAggression: thresholds.aggression === "Balanced" ? 70 : thresholds.aggression === "Selective fast momentum" ? 60 : 40,
      watchlistThreshold: watchThreshold,
      earlySetupThreshold: earlyThreshold,
      smallAltStrictConfirmation: confirmationProfile.smallAltStrict ? 100 : 0,
      realTradeMemoryAdjustment: 0,
      pumpDetector: Math.round(intel.pumpScore),
      whaleTracker: Math.round(intel.whaleScore),
      liqBot: Math.round(intel.liqScore),
      marketReport: Math.round(intel.marketScore),
      intelligenceBonus: Math.round(intel.bonus),
      intelligencePenalty: Math.round(intel.penalty),
      intelligenceEntryQuality: Math.round(intel.entryQuality),
      earlyEntryReady: earlyEntryReady ? 100 : 0,
      microConfirmationScore: Math.round(micro.weightedScore),
      microRetestForming: micro.retestForming ? 100 : 0,
      microOrderflowSpeed: micro.strongOrderflow ? 100 : 0,
      microMomentumRising: micro.momentumRising ? 100 : 0
    },
    tradeManagementActions: tradeManagementActions(qualifiedSide, entryStatus),
    management
  };
  const realAdjustment = realTradeQualityAdjustment(signal);
  signal.scoreBreakdown.realTradeMemoryAdjustment = Math.round(realAdjustment * 100) / 100;
  if (realAdjustment !== 0 && signal.score >= 72) {
    const adjustedScore = Math.round(clamp(signal.score + realAdjustment, 0, 100));
    signal.score = adjustedScore;
    signal.confidence = adjustedScore;
    signal.winProbability = Math.round(clamp(adjustedScore, 0, 94));
  }

  if (signal.side === "LONG" || signal.side === "SHORT") {
    const avgEntryCheck = (signal.entry[0] + signal.entry[1]) / 2;
    const levelsOk = signal.side === "LONG"
      ? signal.stopLoss < avgEntryCheck && signal.takeProfit[0] > avgEntryCheck && signal.takeProfit[1] > signal.takeProfit[0] && signal.takeProfit[2] > signal.takeProfit[1]
      : signal.stopLoss > avgEntryCheck && signal.takeProfit[0] < avgEntryCheck && signal.takeProfit[1] < signal.takeProfit[0] && signal.takeProfit[2] < signal.takeProfit[1];
    if (!levelsOk) {
      logger.error({ symbol: signal.symbol, pipelineStage: "LEVELS_INVALID", side: signal.side, entry: signal.entry, avgEntry: Math.round(avgEntryCheck * 100) / 100, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit }, "DecisionEngine: CRITICAL - levels invalid for declared side, downgrading to NO_TRADE");
      signal.entryStatus = "NO_TRADE";
      signal.side = "NO_TRADE";
      signal.rejectionReason = `Internal levels invalid: ${signal.side} signal has SL/TP that don't match direction`;
      return signal;
    }

    const symbolMult = symbolConfidenceMultiplier(snapshot.symbol);
    if (symbolMult !== 1) {
      const adjusted = Math.round(clamp(signal.score * symbolMult, 0, 100));
      signal.score = adjusted;
      signal.confidence = adjusted;
      signal.winProbability = Math.round(clamp(adjusted, 0, 94));
    }

    logger.info({ symbol: signal.symbol, pipelineStage: "SIGNAL_READY", side: signal.side, entry: signal.entry, avgEntry: Math.round(avgEntryCheck * 100) / 100, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, score: signal.score, entryStatus: signal.entryStatus }, "DecisionEngine: signal validated at source, ready for execution");
  }

  return signal;
}

function intelligenceScores(snapshot: MarketSnapshot, direction: number) {
  const intel = snapshot.intelligence;
  if (!intel || direction === 0) return { pumpScore: 0, whaleScore: 0, liqScore: 0, marketScore: 50, momentumHunterScore: 50, entryQuality: 0, aligned: false, hardRisk: false, bonus: 0, penalty: 0 };
  const side = direction === 1 ? "LONG" : "SHORT";
  const pumpAligned = intel.pump.direction === side || intel.pump.direction === "NEUTRAL" && intel.pump.entryTiming !== "AVOID";
  const whaleAligned = intel.whale.whaleBias === side || intel.whale.whaleBias === "NEUTRAL";
  const liqAligned = intel.liq.sweepDirection === side || intel.liq.sweepDirection === "NEUTRAL";
  const marketOk = intel.market.marketRegime !== "RISK_OFF" || side === "SHORT";
  const momentumData = state.momentum.latestBySymbol[snapshot.symbol];
  const mhAligned = momentumData ? momentumData.decision !== "SKIP" : false;
  const mhScore = momentumData ? Math.round((momentumData.pumpProbability * 0.5 + momentumData.momentumScore * 0.3 + momentumData.smartMoneyScore * 0.2)) : 50;
  const alignedCount = [pumpAligned, whaleAligned, liqAligned, marketOk, mhAligned].filter(Boolean).length;
  const pumpScore = pumpAligned ? intel.pump.pumpScore : Math.max(0, 50 - intel.pump.pumpScore);
  const whaleScore = whaleAligned ? intel.whale.smartMoneyScore : Math.max(0, 45 - intel.whale.smartMoneyScore * 0.4);
  const liqScore = liqAligned ? intel.liq.entryQuality : Math.max(0, 45 - intel.liq.entryQuality * 0.4);
  const marketScore = Math.max(0, 100 - intel.market.riskScore + intel.market.marketAggression * 0.35);
  const momentumHunterScore = mhAligned ? mhScore : Math.max(0, 50 - mhScore * 0.4);
  const trapPenalty = Math.max(intel.whale.trapRisk * 0.08, intel.liq.trapProbability * 0.08, intel.pump.fakeBreakoutRisk * 0.1);
  const bonus = pumpScore * 0.04 + whaleScore * 0.04 + liqScore * 0.04 + marketScore * 0.02 + momentumHunterScore * 0.04 + (alignedCount >= 4 ? 5 : alignedCount >= 3 ? 3 : 0);
  const penalty = trapPenalty + (alignedCount <= 2 ? 10 : 0) + (intel.market.marketRegime === "RISK_OFF" && side === "LONG" ? 15 : 0);
  const hardRisk = intel.pump.fakeBreakoutRisk >= 78 || intel.whale.trapRisk >= 82 || intel.liq.trapProbability >= 82 || intel.market.riskScore >= 85;
  return {
    pumpScore,
    whaleScore,
    liqScore,
    marketScore,
    momentumHunterScore,
    entryQuality: (pumpScore + whaleScore + liqScore + marketScore + momentumHunterScore) / 5,
    aligned: alignedCount >= 4,
    hardRisk,
    bonus,
    penalty
  };
}

function professionalIntelligenceAdjustment(snapshot: MarketSnapshot, intel: ReturnType<typeof intelligenceScores>, quality: { side: Side; rrValue: number; newsRisk: AccuracyRisk; volume: number; momentum: number; sniperReady: boolean; liquidityScore: number; fakeBreakoutRisk: boolean }) {
  if (!snapshot.intelligence || snapshot.mode !== "futures" || quality.side === "NO_TRADE" || quality.newsRisk.blocked || quality.rrValue < 2) return 0;
  if (intel.hardRisk || quality.fakeBreakoutRisk) return -8;
  const bundle = snapshot.intelligence;
  const constructive = [
    bundle.pump.pumpScore >= 62 && bundle.pump.entryTiming !== "AVOID",
    bundle.whale.smartMoneyScore >= 58 && bundle.whale.trapRisk < 70,
    bundle.liq.entryQuality >= 55 || bundle.liq.reclaimConfirmed,
    bundle.market.marketAggression >= 45 && bundle.market.riskScore < 70,
    intel.aligned
  ].filter(Boolean).length;
  const caution = [
    bundle.pump.fakeBreakoutRisk >= 65,
    bundle.whale.trapRisk >= 65,
    bundle.liq.trapProbability >= 65,
    bundle.market.riskScore >= 70
  ].filter(Boolean).length;
  const watchlistUpgrade = constructive >= 3 && quality.volume >= 45 && quality.momentum >= 45 && (quality.liquidityScore >= 45 || bundle.liq.reclaimConfirmed);
  const sniperBoost = quality.sniperReady && constructive >= 3 ? 2 : 0;
  return clamp((watchlistUpgrade ? 4 : constructive >= 2 ? 2 : 0) + sniperBoost - caution * 3, -9, 7);
}

function rejectionReason(side: Side, score: number, snapshot: MarketSnapshot, weakMomentum: boolean, rrValue: number, entryThreshold: number, hardBlockReason?: string) {
  if (side === "WATCHLIST") return score >= 82 ? "ТІЛЬКИ МОНІТОРИНГ: сетап близько до порогу, потрібне покращення підтверджень" : "РАННІЙ СЕТАП: цікава структура, моніторинг без входу до retest/sniper підтвердження";
  if (side !== "NO_TRADE") return "Прийнятий сетап з високою ймовірністю";
  if (hardBlockReason) return hardBlockReason;
  if (score >= 82 && score < entryThreshold && snapshot.mode === "futures") return "ТІЛЬКИ МОНІТОРИНГ: сетап близько до порогу, потрібне покращення підтверджень";
  if (score >= 72 && score < 82 && snapshot.mode === "futures") return "РАННІЙ СЕТАП: цікава структура, моніторинг без входу до retest/sniper підтвердження";
  if (snapshot.regime === "MANIPULATION_RISK" || snapshot.regime === "CHOPPY") return "CHOPPY / шумний ринок: немає чистого retest або якісного імпульсу";
  if (!snapshot.btcStable && snapshot.symbol !== "BTCUSDT") return "BTC нестабільний, агресивні угоди по альткоїнах заблоковані";
  if (snapshot.confirmations.conflict) return "Біржові підтвердження конфліктують, угоду пропущено";
  if (snapshot.confirmations.alignedCount < 2) return "Недостатньо підтверджень з бірж, потрібно мінімум 2 джерела";
  if (weakMomentum) return "Слабкий імпульс, угоду пропущено";
  if (rrValue < 2) return `Співвідношення ризик/прибуток ${riskRewardRatio(rrValue)} нижче мінімуму 1:2.0`;
  if (snapshot.regime === "SIDEWAYS" || snapshot.regime === "RANGING") return "SIDEWAYS: потрібен liquidity sweep або mean-reversion setup, trend entry заблоковано";
  if (snapshot.regime === "LOW_VOLATILITY" || snapshot.regime === "COMPRESSION") return "НИЗЬКА ВОЛАТИЛЬНІСТЬ: чекаємо breakout з volume або clean retest";
  if (snapshot.regime === "HIGH_VOLATILITY" || snapshot.regime === "VOLATILE" || snapshot.regime === "NEWS_DRIVEN") return "ВИСОКА ВОЛАТИЛЬНІСТЬ / event risk: leverage entry заблоковано до стабілізації";
  return `Оцінка ${Math.round(score)} нижче порогу високої якості ${entryThreshold}`;
}

function adaptiveConfirmationProfile(snapshot: MarketSnapshot, quality: { volume: number; momentum: number; liquidityScore: number; orderbook: number; fastMoveScore: number }) {
  if (snapshot.confirmations.conflict) return { allowed: false, penalty: 35, smallAltStrict: false, reason: "exchange conflict" };
  const topCoin = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(snapshot.symbol);
  const bybitBinanceOnly = snapshot.confirmations.bybit && snapshot.confirmations.binance && !snapshot.confirmations.okx && !snapshot.confirmations.kucoin;
  const microStrong = quality.momentum >= 82 && quality.fastMoveScore >= 70 || quality.orderbook >= 70 && quality.volume >= 68;
  if (topCoin) return { allowed: snapshot.confirmations.alignedCount >= 2, penalty: snapshot.confirmations.alignedCount >= 2 ? 0 : 35, smallAltStrict: false, reason: "top coin requires 2+ exchanges" };
  if (bybitBinanceOnly) {
    const strongInternal = quality.volume >= 72 && quality.momentum >= 76 && quality.liquidityScore >= 58 && quality.orderbook >= 60 && quality.fastMoveScore >= 60;
    return { allowed: strongInternal, penalty: strongInternal ? 6 : 35, smallAltStrict: true, reason: strongInternal ? "Bybit+Binance with strict internal validation" : "small alt internal validation too weak" };
  }
  if (snapshot.confirmations.alignedCount >= 2) return { allowed: true, penalty: 0, smallAltStrict: false, reason: "2+ exchanges confirmed" };
  if (snapshot.confirmations.alignedCount >= 1 && microStrong && snapshot.btcStable && snapshot.regime !== "CHOPPY" && snapshot.regime !== "LOW_VOLATILITY") return { allowed: true, penalty: 8, smallAltStrict: true, reason: "micro-confirmation replaced one weak exchange confirmation" };
  return { allowed: false, penalty: 35, smallAltStrict: false, reason: "small alt needs Bybit+Binance or 2+ exchanges" };
}

function microConfirmationProfile(snapshot: MarketSnapshot, quality: { momentum: number; volume: number; orderbook: number; orderFlowScore: number; liquidityScore: number; sniperScore: number; fastMoveScore: number; fakeBreakoutRisk: boolean; newsBlocked: boolean; rrValue: number }) {
  const trending = snapshot.regime === "TRENDING" || snapshot.regime === "BREAKOUT" || snapshot.regime === "EXPANSION";
  const strict = snapshot.regime === "LOW_VOLATILITY" || snapshot.regime === "CHOPPY" || snapshot.regime === "SIDEWAYS" || snapshot.regime === "RANGING";
  const momentumRising = quality.momentum >= (trending ? 66 : 72) && quality.fastMoveScore >= 58;
  const volumeIncreasing = quality.volume >= (trending ? 58 : 64);
  const retestForming = quality.liquidityScore >= 62 || quality.sniperScore >= 55;
  const sniperNear = quality.sniperScore >= 52;
  const strongOrderflow = quality.orderFlowScore >= 68 || quality.orderbook >= 66;
  const weightedScore = clamp(
    quality.momentum * 0.24
    + quality.volume * 0.18
    + quality.liquidityScore * 0.17
    + quality.orderFlowScore * 0.16
    + quality.sniperScore * 0.13
    + quality.fastMoveScore * 0.12
    + (trending ? 6 : strict ? -8 : 0)
  );
  const tinyAccountOk = quality.rrValue >= 2.4 && quality.volume >= 62 && quality.momentum >= 68 && (retestForming || strongOrderflow);
  const earlyThreshold = trending ? 78 : strict ? 86 : 82;
  const ready = weightedScore >= earlyThreshold
    && momentumRising
    && volumeIncreasing
    && retestForming
    && sniperNear
    && snapshot.btcStable
    && !quality.fakeBreakoutRisk
    && !quality.newsBlocked
    && quality.rrValue >= 2
    && (trending || strongOrderflow)
    && (tinyAccountOk || !config.smallBalanceGrowthMode);
  return { ready, weightedScore, earlyThreshold, momentumRising, volumeIncreasing, retestForming, sniperNear, strongOrderflow, tinyAccountOk };
}

function setupTypeFromScores(snapshot: MarketSnapshot, scores: { momentum: number; volume: number; mtf: number; liquiditySweep: number }) {
  if (scores.liquiditySweep >= 65 && snapshot.btcStable) return "liquidity_sweep_btc_stable";
  if (scores.momentum >= 55 && scores.volume < 65) return "macd_weak_volume";
  if (scores.mtf >= 67) return "mtf_alignment";
  return "borderline_standard";
}

function marketQualityProfile(snapshot: MarketSnapshot, quality: { trendStrength: number; momentum: number; volume: number; orderbook: number; fastMoveScore: number; fakeBreakoutRisk: boolean }) {
  const profiles: Record<MarketRegime, { penalty: number; trendWeight: number; momentumWeight: number; score: number }> = {
    TRENDING: { penalty: 0, trendWeight: 0.14, momentumWeight: 0.1, score: 90 },
    BREAKOUT: { penalty: quality.volume >= 65 && quality.fastMoveScore >= 55 ? 2 : 18, trendWeight: 0.12, momentumWeight: 0.11, score: quality.volume >= 65 ? 85 : 65 },
    REVERSAL: { penalty: quality.orderbook >= 60 && quality.momentum >= 70 ? 8 : 22, trendWeight: 0.08, momentumWeight: 0.1, score: 70 },
    SIDEWAYS: { penalty: 22, trendWeight: 0.05, momentumWeight: 0.06, score: 55 },
    LOW_VOLATILITY: { penalty: 18, trendWeight: 0.06, momentumWeight: 0.06, score: 60 },
    HIGH_VOLATILITY: { penalty: 26, trendWeight: 0.08, momentumWeight: 0.07, score: 45 },
    CHOPPY: { penalty: quality.volume >= 65 && quality.momentum >= 65 ? 18 : 28, trendWeight: 0.06, momentumWeight: 0.07, score: quality.volume >= 65 && quality.momentum >= 65 ? 55 : 35 },
    RANGING: { penalty: 28, trendWeight: 0.05, momentumWeight: 0.06, score: 50 },
    EXPANSION: { penalty: 2, trendWeight: 0.12, momentumWeight: 0.1, score: 80 },
    COMPRESSION: { penalty: 18, trendWeight: 0.06, momentumWeight: 0.06, score: 55 },
    VOLATILE: { penalty: 26, trendWeight: 0.08, momentumWeight: 0.07, score: 45 },
    NEWS_DRIVEN: { penalty: 40, trendWeight: 0.04, momentumWeight: 0.04, score: 20 },
    MANIPULATION_RISK: { penalty: 45, trendWeight: 0.04, momentumWeight: 0.04, score: 20 }
  };
  const profile = profiles[snapshot.regime];
  return quality.fakeBreakoutRisk ? { ...profile, penalty: profile.penalty + 10, score: Math.max(0, profile.score - 20) } : profile;
}

function coinQualityProfile(snapshot: MarketSnapshot, quality: { volume: number; orderbook: number; volatilityPct: number; fakeBreakoutRisk: boolean }) {
  const major = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(snapshot.symbol);
  const availability = snapshot.confirmations.alignedCount;
  const liquidity = snapshot.liquidityScore;
  const stableVolume = quality.volume >= 55;
  const orderbookOk = quality.orderbook >= 50;
  const volatilityQuality = quality.volatilityPct >= 0.0025 && quality.volatilityPct <= 0.018;
  if (major && liquidity >= 55 && availability >= 2) return { tier: "A-TIER" as const, penalty: 0, watchThreshold: 82 };
  if (liquidity >= 50 && availability >= 2 && stableVolume && orderbookOk && volatilityQuality && !quality.fakeBreakoutRisk) return { tier: "B-TIER" as const, penalty: 4, watchThreshold: 82 };
  return { tier: "C-TIER" as const, penalty: 8, watchThreshold: 82 };
}

function btcAltRiskPenalty(snapshot: MarketSnapshot, direction: number, correlation: CorrelationContext) {
  if (snapshot.symbol === "BTCUSDT") return 0;
  let penalty = 0;
  if (!snapshot.btcStable) penalty += 16;
  if (correlation.riskOff && direction === 1) penalty += 18;
  if (correlation.btcDirection !== 0 && direction !== 0 && correlation.btcDirection !== direction) penalty += 10;
  if (correlation.aligned && direction !== 0) penalty -= 4;
  return Math.max(0, penalty);
}

function earlySetupFloor(snapshot: MarketSnapshot, quality: { side: Side; executionAligned: boolean; htfScore: number; trendStrength: number; mtf: number; volume: number; orderFlowScore: number; liquidityScore: number; funding: number; fakeBreakoutRisk: boolean; newsBlocked: boolean; rrValue: number }) {
  if (snapshot.mode !== "futures" || quality.side === "NO_TRADE" || quality.newsBlocked || quality.rrValue < 2) return 0;
  if (quality.funding < 70 || !snapshot.btcStable) return 0;
  const structureReady = quality.executionAligned || quality.htfScore >= 55 || quality.mtf >= 67;
  if (!structureReady || quality.trendStrength < 8 && quality.mtf < 67 && quality.htfScore < 55) return 0;
  const confirmations = [quality.executionAligned, quality.htfScore >= 55, quality.mtf >= 67, quality.volume >= 50, quality.orderFlowScore >= 80, quality.liquidityScore >= 70, snapshot.btcStable].filter(Boolean).length;
  if (quality.fakeBreakoutRisk) return confirmations >= 4 ? 72 : 0;
  if (confirmations >= 5) return 85;
  if (confirmations >= 4) return 82;
  if (confirmations >= 3 && quality.volume >= 45 && quality.orderFlowScore >= 60) return 72;
  return 0;
}

function leverageRecommendation(score: number, volatility: number, momentum: number, regime: MarketRegime) {
  let leverage = score >= 95 ? 3 : 2;
  if (volatility > 0.018 || regime === "VOLATILE" || regime === "HIGH_VOLATILITY" || regime === "NEWS_DRIVEN" || regime === "CHOPPY") leverage = Math.min(leverage, 2);
  else if (volatility > 0.012 || momentum < 70) leverage = Math.min(leverage, 3);
  if (score < 92) leverage = Math.min(leverage, 3);
  if (score < 85) leverage = 2;
  return `x${leverage}`;
}

function riskRewardValue(entry: [number, number], stopLoss: number, tp3: number, direction: number) {
  const averageEntry = (entry[0] + entry[1]) / 2;
  const risk = Math.abs(averageEntry - stopLoss);
  const reward = Math.abs(tp3 - averageEntry);
  if (!Number.isFinite(risk) || risk <= 0 || direction === 0) return 0;
  return reward / risk;
}

function riskRewardRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "Немає даних";
  return `1:${value.toFixed(1)}`;
}

function executionDirection(candles: Record<string, Candle[]>, mode: "spot" | "futures") {
  if (mode === "spot") return { direction: trendDirection(candles["240"]), aligned: true };
  const oneHour = trendDirection(candles["60"]);
  const fifteen = trendDirection(candles["15"]);
  const one = precisionDirection(candles["1"]);
  const three = precisionDirection(candles["3"]);
  const five = precisionDirection(candles["5"]);
  const precisionVotes = [one, three, five].filter((dir) => dir !== 0);
  const precisionAligned = !precisionVotes.length || precisionVotes.some((dir) => dir === oneHour);
  const aligned = oneHour !== 0 && oneHour === fifteen && precisionAligned;
  return { direction: aligned ? oneHour : 0, aligned };
}

function bestEntryTimingCandles(oneMinute: Candle[], threeMinute: Candle[], fiveMinute: Candle[], direction: number) {
  const candidates = [oneMinute, threeMinute, fiveMinute].filter((candles) => candles.length >= 25);
  if (!candidates.length || direction === 0) return oneMinute.length ? oneMinute : fiveMinute;
  return candidates
    .map((candles) => ({ candles, score: precisionDirection(candles) === direction ? 2 : 0, volume: volumeProfileScore(candles) }))
    .sort((a, b) => b.score - a.score || b.volume - a.volume)[0].candles;
}

function precisionDirection(candles?: Candle[]) {
  if (!candles || candles.length < 30) return 0;
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, 9).at(-1) ?? 0;
  const slow = ema(closes, 21).at(-1) ?? 0;
  const last = candles.at(-1)!;
  const previous = candles.at(-4)!;
  const rejectionLong = last.low < Math.min(...candles.slice(-20, -1).map((c) => c.low)) && last.close > previous.close;
  const rejectionShort = last.high > Math.max(...candles.slice(-20, -1).map((c) => c.high)) && last.close < previous.close;
  if (fast > slow && last.close > fast || rejectionLong) return 1;
  if (fast < slow && last.close < fast || rejectionShort) return -1;
  return 0;
}

function entrySniperTrigger(fiveMinute: Candle[], oneMinute: Candle[], direction: number, setupVolume: number) {
  if (direction === 0 || oneMinute.length < 25 || fiveMinute.length < 25) return { ready: false, score: 0 };
  const last = oneMinute.at(-1)!;
  const previous = oneMinute.at(-2)!;
  const local = oneMinute.slice(-20, -1);
  const vw = vwap(oneMinute);
  const volumeScore = volumeProfileScore(oneMinute);
  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, 1e-9);
  const rejection = direction === 1
    ? last.low <= Math.min(...local.map((c) => c.low)) && last.close > last.open && body / range >= 0.45
    : last.high >= Math.max(...local.map((c) => c.high)) && last.close < last.open && body / range >= 0.45;
  const retest = direction === 1 ? last.low <= vw && last.close > vw : last.high >= vw && last.close < vw;
  const pullback = direction === 1 ? previous.close < last.close && last.low < previous.low : previous.close > last.close && last.high > previous.high;
  const microTrend = precisionDirection(oneMinute) === direction || precisionDirection(fiveMinute) === direction;
  const volumeOk = volumeScore >= 65 || setupVolume >= 72;
  const score = (rejection ? 30 : 0) + (retest ? 25 : 0) + (pullback ? 15 : 0) + (microTrend ? 15 : 0) + (volumeOk ? 15 : 0);
  return { ready: score >= 70, score };
}

function professionalTradeLevels(primary: Candle[], precision: Candle[], oneHour: Candle[], side: "LONG" | "SHORT", a: number, sr: { support: number; resistance: number }) {
  const last = primary.at(-1)!;
  const precisionSr = supportResistance(precision.length >= 30 ? precision : primary);
  const h1Sr = supportResistance(oneHour.length >= 30 ? oneHour : primary);
  const averageAtr = Math.max(a, atr(precision, 14), last.close * 0.001);
  const long = side === "LONG";

  const rawSupport = Math.max(sr.support, precisionSr.support);
  const rawResistance = Math.min(sr.resistance, precisionSr.resistance);
  const rangeWidth = rawResistance - rawSupport;
  const minRange = averageAtr * 0.5;
  const localSupport = rangeWidth < minRange ? last.close - minRange * 0.6 : rawSupport;
  const localResistance = rangeWidth < minRange ? last.close + minRange * 0.4 : rawResistance;

  let entry: [number, number];
  let stopLoss: number;
  let risk: number;

  if (long) {
    entry = [Math.max(localSupport, last.close - averageAtr * 0.35), last.close + averageAtr * 0.08];
    const avgEntry = (entry[0] + entry[1]) / 2;
    stopLoss = Math.min(localSupport - averageAtr * 0.25, avgEntry - averageAtr * 1.25);
    if (stopLoss >= avgEntry) {
      stopLoss = avgEntry - averageAtr * 1.25;
    }
    risk = Math.max(Math.abs(avgEntry - stopLoss), averageAtr * 0.8);
    const tp1Base = avgEntry + risk * 1.2;
    const tp1 = h1Sr.resistance > avgEntry ? Math.min(h1Sr.resistance, tp1Base) : tp1Base;
    const tp2 = Math.max(tp1 + risk * 0.3, avgEntry + risk * 2);
    const tp3 = Math.max(tp2 + risk * 0.3, avgEntry + risk * 3);

    if (stopLoss >= avgEntry) {
      logger.error({ symbol: last.symbol, avgEntry, stopLoss, tp1, tp2, tp3 }, "LONG level validation FAILED: SL >= Entry, forcing correction");
      stopLoss = avgEntry - averageAtr * 1.25;
      risk = Math.abs(avgEntry - stopLoss);
      const correctedTp1 = avgEntry + risk * 1.2;
      const correctedTp2 = avgEntry + risk * 2;
      const correctedTp3 = avgEntry + risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }
    if (tp1 <= avgEntry || tp2 <= avgEntry || tp3 <= avgEntry) {
      logger.error({ symbol: last.symbol, avgEntry, tp1, tp2, tp3 }, "LONG level validation FAILED: TP <= Entry, forcing correction");
      const correctedTp1 = avgEntry + risk * 1.2;
      const correctedTp2 = avgEntry + risk * 2;
      const correctedTp3 = avgEntry + risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }
    if (tp1 >= tp2 || tp2 >= tp3) {
      logger.error({ symbol: last.symbol, tp1, tp2, tp3 }, "LONG level validation FAILED: TP not ascending, forcing correction");
      const correctedTp1 = avgEntry + risk * 1.2;
      const correctedTp2 = avgEntry + risk * 2;
      const correctedTp3 = avgEntry + risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }

    logger.debug({ symbol: last.symbol, side: "LONG", entry, avgEntry, stopLoss, risk: Math.round(risk * 100) / 100, tp1, tp2, tp3, rr1: Math.round((tp1 - avgEntry) / risk * 10) / 10, rr2: Math.round((tp2 - avgEntry) / risk * 10) / 10, rr3: Math.round((tp3 - avgEntry) / risk * 10) / 10 }, "professionalTradeLevels LONG generated");
    return { entry, stopLoss, takeProfit: [tp1, tp2, tp3] as [number, number, number] };
  } else {
    entry = [last.close - averageAtr * 0.08, Math.min(localResistance, last.close + averageAtr * 0.35)];
    const avgEntry = (entry[0] + entry[1]) / 2;
    stopLoss = Math.max(localResistance + averageAtr * 0.25, avgEntry + averageAtr * 1.25);
    if (stopLoss <= avgEntry) {
      stopLoss = avgEntry + averageAtr * 1.25;
    }
    risk = Math.max(Math.abs(stopLoss - avgEntry), averageAtr * 0.8);
    const tp1Base = avgEntry - risk * 1.2;
    const tp1 = h1Sr.support < avgEntry ? Math.max(h1Sr.support, tp1Base) : tp1Base;
    const tp2 = Math.min(tp1 - risk * 0.3, avgEntry - risk * 2);
    const tp3 = Math.min(tp2 - risk * 0.3, avgEntry - risk * 3);

    if (stopLoss <= avgEntry) {
      logger.error({ symbol: last.symbol, avgEntry, stopLoss, tp1, tp2, tp3 }, "SHORT level validation FAILED: SL <= Entry, forcing correction");
      stopLoss = avgEntry + averageAtr * 1.25;
      risk = Math.abs(stopLoss - avgEntry);
      const correctedTp1 = avgEntry - risk * 1.2;
      const correctedTp2 = avgEntry - risk * 2;
      const correctedTp3 = avgEntry - risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }
    if (tp1 >= avgEntry || tp2 >= avgEntry || tp3 >= avgEntry) {
      logger.error({ symbol: last.symbol, avgEntry, tp1, tp2, tp3 }, "SHORT level validation FAILED: TP >= Entry, forcing correction");
      const correctedTp1 = avgEntry - risk * 1.2;
      const correctedTp2 = avgEntry - risk * 2;
      const correctedTp3 = avgEntry - risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }
    if (tp1 <= tp2 || tp2 <= tp3) {
      logger.error({ symbol: last.symbol, tp1, tp2, tp3 }, "SHORT level validation FAILED: TP not descending, forcing correction");
      const correctedTp1 = avgEntry - risk * 1.2;
      const correctedTp2 = avgEntry - risk * 2;
      const correctedTp3 = avgEntry - risk * 3;
      return { entry, stopLoss, takeProfit: [correctedTp1, correctedTp2, correctedTp3] as [number, number, number] };
    }

    logger.debug({ symbol: last.symbol, side: "SHORT", entry, avgEntry, stopLoss, risk: Math.round(risk * 100) / 100, tp1, tp2, tp3, rr1: Math.round((avgEntry - tp1) / risk * 10) / 10, rr2: Math.round((avgEntry - tp2) / risk * 10) / 10, rr3: Math.round((avgEntry - tp3) / risk * 10) / 10 }, "professionalTradeLevels SHORT generated");
    return { entry, stopLoss, takeProfit: [tp1, tp2, tp3] as [number, number, number] };
  }
}

function managementText(side: Side, entryStatus: Signal["entryStatus"]) {
  if (side === "NO_TRADE") return "❌ НЕ ВХОДИТИ";
  if (entryStatus === "EARLY_ENTRY_READY") return "🟡 EARLY ENTRY READY: готуватися, але чекати фінальний trigger/REAL ENTRY";
  if (side === "WATCHLIST") return "⚠️ ТІЛЬКИ МОНІТОРИНГ";
  if (entryStatus === "WAIT_FOR_ENTRY") return "⏳ ЧЕКАТИ ЗОНУ ВХОДУ";
  return "✅ ЗАХОДИТИ ЗАРАЗ; після TP1 перенести SL у беззбиток, на TP2 зафіксувати частину, залишок вести трейлінгом ATR";
}

function tradeManagementActions(side: Side, entryStatus: Signal["entryStatus"]) {
  if (side === "NO_TRADE") return ["❌ НЕ ВХОДИТИ"];
  if (entryStatus === "EARLY_ENTRY_READY") return ["🟡 EARLY ENTRY READY", "⏳ ЧЕКАТИ REAL ENTRY CONFIRMATION", "🛡 SL/ризик вже пораховані, не входити без trigger"];
  if (side === "WATCHLIST") return ["⚠️ ТІЛЬКИ МОНІТОРИНГ"];
  if (entryStatus === "WAIT_FOR_ENTRY") return ["⏳ ЧЕКАТИ ЗОНУ ВХОДУ"];
  return ["🟢 ЗАХОДИТИ ЗАРАЗ", "🟡 ТРИМАТИ ПОЗИЦІЮ", "🟠 ЗАФІКСУВАТИ ЧАСТИНУ ПРИБУТКУ", "🟠 ПЕРЕНЕСТИ STOP LOSS У БЕЗЗБИТОК", "🟠 АКТИВОВАНО ТРЕЙЛІНГ-СТОП", "🔴 ВИЙТИ З УГОДИ ЗАРАЗ", "⚠️ ВИЯВЛЕНО РОЗВОРОТ ТРЕНДУ"];
}

function multiTimeframeScore(snapshot: MarketSnapshot, direction: number) {
  if (direction === 0) return 0;
  const tfs = snapshot.mode === "futures" ? ["5", "15", "60"] : ["60", "240", "D"];
  const aligned = tfs.filter((tf) => {
    const c = snapshot.candles[tf] ?? [];
    const closes = c.map((x) => x.close);
    const e20 = ema(closes, 20).at(-1) ?? 0;
    const e50 = ema(closes, 50).at(-1) ?? 0;
    return direction === 1 ? e20 > e50 : e20 < e50;
  }).length;
  return (aligned / tfs.length) * 100;
}

function reasons(snapshot: MarketSnapshot, parts: Record<string, number>, advanced: { session: AccuracySession; newsRisk: AccuracyRisk; htf: HigherTimeframeBias; liquidity: LiquidityIntelligence; orderFlow: OrderFlowAnalysis; oiAnalysis: OpenInterestAnalysis; fakeBreakout: FakeBreakoutAnalysis; fastMove: FastMoveQuality; correlation: CorrelationContext }) {
  const out = [`Режим ринку: ${marketRegimeUa(snapshot.regime)}`, `Фільтр BTC: ${snapshot.btcStable ? "стабільний" : "нестабільний"}`];
  out.push(advanced.session.message);
  if (advanced.newsRisk.blocked) out.push(advanced.newsRisk.message);
  if (!advanced.htf.executionAligned) out.push("1H/15M/5M execution alignment не підтверджений");
  else if (advanced.htf.counterTrend) out.push("⚠️ 15m/1h контекст конфліктує: штраф за контртренд");
  else out.push("✅ 1H/15M/5M execution aligned");
  out.push(advanced.liquidity.message, advanced.orderFlow.message, advanced.oiAnalysis.message);
  out.push(advanced.fastMove.message);
  if (advanced.fakeBreakout.risk) out.push(advanced.fakeBreakout.message);
  if (!advanced.correlation.aligned) out.push(`Кореляційний фільтр: ${advanced.correlation.details.join("; ")}`);
  if (snapshot.regime === "MANIPULATION_RISK" || snapshot.regime === "CHOPPY" || snapshot.regime === "HIGH_VOLATILITY") out.push("⚠️ РИНОК ВИСОКОГО РИЗИКУ — НЕ ВХОДИТИ");
  if (parts.trendStrength > 55) out.push("структура EMA підтверджує сильний тренд");
  if (parts.volume > 65) out.push("обсяг підтверджує рух вище недавнього профілю");
  if (parts.smc > 50) out.push("SMC підтверджено через BOS/CHOCH/liquidity sweep/FVG");
  if (parts.mtf > 65) out.push("мультитаймфрейм підтверджує напрямок");
  if (parts.orderbook > 60) out.push("дисбаланс стакана підтримує напрямок");
  if (Math.abs(snapshot.fundingRate) < 0.0008) out.push("funding не перегрітий");
  if (snapshot.intelligence) {
    out.push(`Pump Detector: ${snapshot.intelligence.pump.pumpScore}/100, timing ${snapshot.intelligence.pump.entryTiming}`);
    out.push(`Whale Tracker: ${snapshot.intelligence.whale.whaleBias} ${snapshot.intelligence.whale.smartMoneyScore}/100, trap ${snapshot.intelligence.whale.trapRisk}/100`);
    out.push(`Liq Bot: ${snapshot.intelligence.liq.sweepDirection} ${snapshot.intelligence.liq.entryQuality}/100, reclaim ${snapshot.intelligence.liq.reclaimConfirmed ? "yes" : "no"}`);
    out.push(`Market Report: ${snapshot.intelligence.market.marketRegime}, aggression ${snapshot.intelligence.market.marketAggression}/100`);
  }
  if (snapshot.confirmations.alignedCount >= 2) out.push(`підтверджено біржами: ${confirmedBy(snapshot).join(", ")}`);
  return out;
}

function confirmedBy(snapshot: MarketSnapshot) {
  return [snapshot.confirmations.bybit ? "Bybit" : "", snapshot.confirmations.okx ? "OKX" : "", snapshot.confirmations.kucoin ? "KuCoin" : "", snapshot.confirmations.binance ? "Binance" : ""].filter(Boolean);
}

function marketRegimeUa(regime: MarketRegime) {
  const map: Record<MarketRegime, string> = { TRENDING: "трендовий", SIDEWAYS: "боковий", BREAKOUT: "breakout", REVERSAL: "reversal", HIGH_VOLATILITY: "висока волатильність", LOW_VOLATILITY: "низька волатильність", CHOPPY: "шумний/choppy", RANGING: "боковий", EXPANSION: "розширення волатильності", COMPRESSION: "стиснення волатильності", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}

function sessionFilter(now: Date, snapshot?: MarketSnapshot): AccuracySession {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minutes = hour * 60 + minute;
  const candles = snapshot?.candles["15"] ?? snapshot?.candles["60"] ?? [];
  const last20 = candles.slice(-20);
  const currentVol = last20.length >= 2 ? last20.slice(-2).reduce((s, c) => s + c.volume, 0) / 2 : 0;
  const avgVol = last20.length >= 10 ? last20.slice(-10, -2).reduce((s, c) => s + c.volume, 0) / 8 : currentVol;
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1;
  const a = candles.length >= 20 ? atr(candles) : 0;
  const last = candles.at(-1);
  const volPct = a > 0 && last ? a / last.close : 0;
  const liquidityActive = volRatio > 0.8 || volPct > 0.008;
  const volumeBoost = clamp((volRatio - 1) * 15);
  const volatilityBoost = clamp(volPct * 800);
  const dynamicBoost = liquidityActive ? Math.max(volumeBoost, volatilityBoost) : -Math.max(5, volumeBoost * 0.5);

  if (minutes >= 420 && minutes <= 570) {
    const adj = clamp(6 + dynamicBoost, -5, 12);
    return { name: "LONDON_OPEN", active: adj > -2, confidenceAdjustment: adj, message: adj > 0 ? "✅ London Open: ліквідність активна" : "⚠️ London Open: низька активність" };
  }
  if (minutes >= 780 && minutes <= 960) {
    const adj = clamp(8 + dynamicBoost, -3, 14);
    return { name: "LONDON_NY_OVERLAP", active: adj > -2, confidenceAdjustment: adj, message: adj > 0 ? "✅ London + NY overlap: найкраща ліквідність" : "⚠️ London+NY overlap: знижена активність" };
  }
  if (minutes >= 780 && minutes <= 930) {
    const adj = clamp(7 + dynamicBoost, -4, 13);
    return { name: "NEW_YORK_OPEN", active: adj > -2, confidenceAdjustment: adj, message: adj > 0 ? "✅ New York Open: ліквідність активна" : "⚠️ NY Open: знижена активність" };
  }
  if (minutes >= 0 && minutes <= 360) {
    const adj = clamp(-18 + dynamicBoost * 2, -20, 5);
    return { name: "ASIA_CHOP", active: adj > -2, confidenceAdjustment: adj, message: adj > 0 ? "✅ Asia session: аномальна активність" : "⚠️ Asia low liquidity: тільки sniper entry" };
  }
  const adj = clamp(-10 + dynamicBoost, -16, 6);
  return { name: "OFF_HOURS", active: adj > -2, confidenceAdjustment: adj, message: adj > 0 ? "✅ Off-hours: підвищена активність" : "⚠️ Off-hours: знижена впевненість" };
}

function highImpactNewsRisk(snapshot: MarketSnapshot, last: Candle, a: number): AccuracyRisk {
  const manualUntil = config.HIGH_IMPACT_NEWS_BLOCK_UNTIL ? Date.parse(config.HIGH_IMPACT_NEWS_BLOCK_UNTIL) : 0;
  const userMode = config.HIGH_IMPACT_NEWS_MODE ?? "CRITICAL";
  const reasons: string[] = [];
  if (manualUntil && manualUntil > Date.now()) reasons.push(`manual news block до ${new Date(manualUntil).toISOString()}`);
  if (snapshot.regime === "NEWS_DRIVEN") reasons.push("NEWS_DRIVEN режим за ATR/volume");
  if (snapshot.regime === "HIGH_VOLATILITY") reasons.push("high volatility regime: можливі liquidation/event spikes");
  if (Math.abs(snapshot.fundingRate) > 0.0008) reasons.push("funding overheated: можливий squeeze/ETF/news reaction");
  if (Math.abs(snapshot.openInterestChange) > 0.012 && volumeProfileScore(snapshot.candles["15"] ?? []) > 80) reasons.push("extreme OI + volume: можливий liquidation event");
  if (isMacroEventWindow(new Date())) reasons.push("CPI/FOMC macro event risk window");
  if (a / last.close > 0.035) reasons.push("macro volatility spike за ATR");
  const nfpWindow = isFirstFridayNfpWindow(new Date());
  if (nfpWindow) reasons.push("можливе NFP/Fed macro window");
  const riskFound = reasons.length > 0;
  if (!riskFound) return { blocked: false, severity: "LOW", message: "✅ Немає активного high-impact news block", reasons };
  if (userMode === "CRITICAL") return { blocked: true, severity: "HIGH", message: "⚠️ ВИСОКИЙ НОВИННИЙ РИЗИК — НЕ ВХОДИТИ", reasons };
  if (userMode === "MEDIUM") return { blocked: true, severity: "MEDIUM", message: "⚠️ СЕРЕДНІЙ НОВИННИЙ РИЗИК — зменшення ризику", reasons };
  return { blocked: false, severity: "LOW", message: "✅ Новини виявлені, але LOW режим — торгівля дозволена", reasons };
}

function isFirstFridayNfpWindow(now: Date) {
  const day = now.getUTCDay();
  const date = now.getUTCDate();
  const hour = now.getUTCHours();
  return day === 5 && date <= 7 && hour >= 11 && hour <= 15;
}

function isMacroEventWindow(now: Date) {
  const day = now.getUTCDay();
  const date = now.getUTCDate();
  const hour = now.getUTCHours();
  const likelyFomc = day === 3 && date >= 14 && date <= 22 && hour >= 17 && hour <= 21;
  const likelyCpi = date >= 10 && date <= 14 && hour >= 11 && hour <= 15;
  return likelyFomc || likelyCpi;
}

function higherTimeframeBias(candles: Record<string, Candle[]>, direction: number): HigherTimeframeBias {
  if (direction === 0) return { direction: 0, aligned: false, executionAligned: false, counterTrend: false, confidenceAdjustment: -12, score: 0, details: ["немає 1H/15M/5M execution alignment"] };
  const frames = ["5", "15", "60"];
  const dirs = frames.map((tf) => [tf, trendDirection(candles[tf])] as const);
  const oneHour = dirs.find(([tf]) => tf === "60")?.[1] ?? 0;
  const fifteen = dirs.find(([tf]) => tf === "15")?.[1] ?? 0;
  const five = precisionDirection(candles["5"]);
  const fourHour = 0;
  const daily = 0;
  const executionAligned = oneHour === direction && fifteen === direction && (five === direction || five === 0);
  const contextConflicts = [fourHour, daily].filter((dir) => dir !== 0 && dir !== direction).length;
  const counterTrend = contextConflicts > 0;
  const alignedCount = dirs.filter(([, dir]) => dir === direction).length;
  const contextAdjustment = contextConflicts === 2 ? -8 : contextConflicts === 1 ? -4 : 4;
  const executionScore = executionAligned ? 75 : 30;
  const contextScore = Math.max(0, 25 - contextConflicts * 8);
  return {
    direction,
    aligned: executionAligned,
    executionAligned,
    counterTrend,
    confidenceAdjustment: contextAdjustment,
    score: executionScore + contextScore,
    details: [
      ...dirs.map(([tf, dir]) => `${tf}: ${dir > 0 ? "LONG" : dir < 0 ? "SHORT" : "нейтрально"}`),
      counterTrend ? "15m/1h контекст конфліктує: штраф за контртренд" : "15m/1h контекст підтримує напрямок"
    ]
  };
}

function trendDirection(candles?: Candle[]) {
  if (!candles || candles.length < 55) return 0;
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20).at(-1) ?? 0;
  const e50 = ema(closes, 50).at(-1) ?? 0;
  const last = candles.at(-1)!;
  if (e20 > e50 && last.close > e20) return 1;
  if (e20 < e50 && last.close < e20) return -1;
  return 0;
}

function liquidityIntelligence(candles: Candle[], direction: number): LiquidityIntelligence {
  const data = candles.slice(-60);
  const last = data.at(-1)!;
  const prior = data.slice(0, -1);
  const liquidityPoolAbove = Math.max(...prior.map((c) => c.high));
  const liquidityPoolBelow = Math.min(...prior.map((c) => c.low));
  const sweptAbove = last.high > liquidityPoolAbove && last.close < liquidityPoolAbove;
  const sweptBelow = last.low < liquidityPoolBelow && last.close > liquidityPoolBelow;
  const sweepDirection = sweptAbove ? -1 : sweptBelow ? 1 : 0;
  const score = sweepDirection === direction ? 100 : sweepDirection === 0 ? 45 : 0;
  const message = sweptAbove ? "✅ Ліквідність зверху знята: SHORT підтвердження" : sweptBelow ? "✅ Ліквідність знизу знята: LONG підтвердження" : "⚠️ Немає чистого liquidity sweep confirmation";
  return { direction: sweepDirection, score, sweptAbove, sweptBelow, liquidityPoolAbove, liquidityPoolBelow, message };
}

function orderFlowAnalysis(candles: Candle[], direction: number): OrderFlowAnalysis {
  const data = candles.slice(-40);
  const cvd = data.reduce((sum, c) => sum + ((c.close - c.open) / Math.max(c.high - c.low, 1e-9)) * c.volume, 0);
  const priceChange = data.at(-1)!.close - data[0].open;
  const cvdDirection = cvd > 0 ? 1 : cvd < 0 ? -1 : 0;
  const priceDirection = priceChange > 0 ? 1 : priceChange < 0 ? -1 : 0;
  const trapRisk = priceDirection !== 0 && cvdDirection !== 0 && priceDirection !== cvdDirection;
  const score = trapRisk ? 0 : cvdDirection === direction ? 100 : cvdDirection === 0 ? 45 : 20;
  return { cvd, direction: cvdDirection, score, trapRisk, message: trapRisk ? "⚠️ Дивергенція CVD: ризик пастки" : cvdDirection === direction ? "✅ CVD/order flow підтримує напрямок" : "⚠️ CVD не дає сильного підтвердження" };
}

function openInterestAnalysis(oiChange: number, last: Candle, previous: Candle | undefined, direction: number): OpenInterestAnalysis {
  const priceDir = previous ? (last.close > previous.close ? 1 : last.close < previous.close ? -1 : 0) : direction;
  const oiDir = oiChange > 0.001 ? 1 : oiChange < -0.001 ? -1 : 0;
  if (priceDir === 1 && oiDir === 1) return { direction: 1, score: direction === 1 ? 100 : 10, message: "✅ Ціна ↑ + OI ↑: сильне LONG продовження" };
  if (priceDir === 1 && oiDir === -1) return { direction: 0, score: 35, message: "⚠️ Ціна ↑ + OI ↓: short covering / слабкий рух" };
  if (priceDir === -1 && oiDir === 1) return { direction: -1, score: direction === -1 ? 100 : 10, message: "✅ Ціна ↓ + OI ↑: сильний SHORT тиск" };
  if (priceDir === -1 && oiDir === -1) return { direction: 0, score: 35, message: "⚠️ Ціна ↓ + OI ↓: слабкий bearish рух" };
  return { direction: 0, score: 50, message: "⚠️ OI neutral: немає сильного підтвердження" };
}

function fakeBreakoutAnalysis(candles: Candle[], direction: number, volumeScore: number, oi: OpenInterestAnalysis, btcOk: boolean, regime: MarketRegime): FakeBreakoutAnalysis {
  const last = candles.at(-1)!;
  const range = Math.max(last.high - last.low, 1e-9);
  const body = Math.abs(last.close - last.open) / range;
  const upperWick = (last.high - Math.max(last.open, last.close)) / range;
  const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
  const reasons: string[] = [];
  if (volumeScore < 45) reasons.push("low volume breakout");
  if (body < 0.35) reasons.push("weak candle close");
  if (direction === 1 && upperWick > 0.45) reasons.push("large upper wick rejection");
  if (direction === -1 && lowerWick > 0.45) reasons.push("large lower wick rejection");
  if (oi.score < 45) reasons.push("weak OI confirmation");
  if (!btcOk) reasons.push("BTC instability");
  if (regime === "MANIPULATION_RISK" || regime === "CHOPPY") reasons.push("manipulated/choppy move risk");
  const risk = reasons.length >= 2;
  return { risk, score: risk ? 0 : 85, reasons, message: risk ? "⚠️ РИЗИК FAKE BREAKOUT — ЧЕКАТИ" : "✅ Ризик fake breakout низький" };
}

function fastMoveQuality(precision: Candle[], setup: Candle[], direction: number, volumeScore: number, orderFlow: OrderFlowAnalysis, regime: MarketRegime): FastMoveQuality {
  const data = precision.length >= 25 ? precision.slice(-25) : setup.slice(-25);
  const reasons: string[] = [];
  if (direction === 0 || data.length < 10) reasons.push("немає чіткого execution direction");
  const a = atr(data, 14);
  const last = data.at(-1);
  const volatilityPct = last ? a / last.close : 0;
  const move = data.length ? Math.abs(data.at(-1)!.close - data[0].open) / Math.max(a, 1e-9) : 0;
  if (regime === "SIDEWAYS" || regime === "RANGING" || regime === "LOW_VOLATILITY" || regime === "COMPRESSION" || regime === "CHOPPY") reasons.push("ринок у chop/compression, швидкий чистий рух не підтверджений");
  if (volatilityPct < 0.0012) reasons.push("занадто низька волатильність для росту малого балансу");
  if (move < 1.2) reasons.push("немає достатнього короткострокового імпульсу");
  if (volumeScore < 55) reasons.push("обсяг слабкий для швидкого intraday руху");
  if (orderFlow.score < 60) reasons.push("order flow/CVD не підтверджує чистий рух");
  const clean = reasons.length === 0;
  const score = clean ? 100 : Math.max(0, 80 - reasons.length * 18);
  return { clean, score, reasons, message: clean ? "✅ Режим малого банку: швидкий чистий рух підтверджено" : `⚠️ РЕЖИМ МАЛОГО БАНКУ — ЧЕКАТИ: ${reasons.join("; ")}` };
}

function accuracyHardBlock(snapshot: MarketSnapshot, input: { side: Side; direction: number; session: AccuracySession; newsRisk: AccuracyRisk; htf: HigherTimeframeBias; liquidity: LiquidityIntelligence; orderFlow: OrderFlowAnalysis; oiAnalysis: OpenInterestAnalysis; fakeBreakout: FakeBreakoutAnalysis; fastMove: FastMoveQuality; correlation: CorrelationContext }) {
  if (input.newsRisk.blocked && input.newsRisk.severity === "HIGH") return { blocked: true, maxScore: 55, reason: input.newsRisk.message };
  if (input.newsRisk.severity === "MEDIUM") return { blocked: false, maxScore: 82, reason: input.newsRisk.message };
  if (!input.session.active) return { blocked: true, maxScore: 79, reason: input.session.message };
  if (!input.htf.executionAligned && input.direction !== 0) return { blocked: true, maxScore: 79, reason: "1H/15M/5M execution alignment не підтверджений" };
  if (input.fakeBreakout.risk) return { blocked: true, maxScore: 79, reason: input.fakeBreakout.message };
  if (config.smallBalanceGrowthMode && !input.fastMove.clean) return { blocked: true, maxScore: 84, reason: input.fastMove.message };
  if (input.orderFlow.trapRisk) return { blocked: true, maxScore: 84, reason: "CVD показує trap risk, потрібне підтвердження без пастки" };
  if (snapshot.symbol !== "BTCUSDT" && input.direction === 1 && (input.correlation.riskOff || !input.correlation.aligned)) return { blocked: true, maxScore: 84, reason: "Кореляційний фільтр ще не підтвердив altcoin LONG" };
  if (snapshot.symbol !== "BTCUSDT" && input.direction === -1 && input.correlation.aligned && !input.correlation.riskOff) return { blocked: true, maxScore: 84, reason: "Кореляційний фільтр ще не підтвердив altcoin SHORT" };
  if ((snapshot.regime === "SIDEWAYS" || snapshot.regime === "RANGING" || snapshot.regime === "CHOPPY") && input.side !== "WATCHLIST") return { blocked: true, maxScore: 84, reason: "SIDEWAYS/CHOPPY ринок: потрібен retest/liquidity sweep перед входом" };
  return { blocked: false, maxScore: 100, reason: undefined };
}

function gradeFrom(score: number, blocked: boolean, side: Side): SignalGrade {
  if (side === "NO_TRADE") return "D";
  if (side === "WATCHLIST") return score >= 82 ? "B" : "C";
  if (blocked && score < 92) return "D";
  if (score >= 92) return "A+";
  if (score >= 85) return "A";
  if (score >= 82) return "B";
  return "D";
}

function signalTtlMs(score: number) {
  if (score >= 92) return 30 * 60 * 1000;
  if (score >= 85) return 20 * 60 * 1000;
  return 15 * 60 * 1000;
}

function neutralCorrelation(): CorrelationContext {
  return { btcDirection: 0, ethDirection: 0, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: false, riskOff: false, details: ["correlation data unavailable"] };
}

function emptyNoTradeSignal(snapshot: MarketSnapshot): Signal {
  return {
    id: `${snapshot.symbol}-${snapshot.mode}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: snapshot.symbol,
    mode: snapshot.mode,
    side: "NO_TRADE",
    score: 0,
    winProbability: 0,
    confidence: 0,
    grade: "D",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    session: { name: "OFF_HOURS", active: false, confidenceAdjustment: 0, message: "" },
    newsRisk: { blocked: true, severity: "HIGH", message: "Symbol paused by learning engine", reasons: ["Symbol paused due to poor performance"] },
    higherTimeframe: { direction: 0, aligned: false, executionAligned: false, counterTrend: false, confidenceAdjustment: 0, score: 0, details: [] },
    liquidityIntelligence: { direction: 0, score: 0, sweptAbove: false, sweptBelow: false, liquidityPoolAbove: 0, liquidityPoolBelow: 0, message: "" },
    orderFlow: { cvd: 0, direction: 0, score: 0, trapRisk: false, message: "" },
    openInterestAnalysis: { direction: 0, score: 0, message: "" },
    fakeBreakout: { risk: true, score: 0, reasons: ["Symbol paused"], message: "" },
    fastMoveQuality: { clean: false, score: 0, message: "", reasons: [] },
    correlation: neutralCorrelation(),
    currentPrice: snapshot.candles["15"]?.at(-1)?.close ?? 0,
    entryStatus: "NO_TRADE",
    entry: [0, 0],
    stopLoss: 0,
    takeProfit: [0, 0, 0],
    riskReward: "Немає даних",
    invalidationLevel: 0,
    holdTime: "",
    marketRegime: snapshot.regime,
    btcStable: snapshot.btcStable,
    confirmations: snapshot.confirmations,
    reasons: ["Symbol paused by learning engine due to poor performance"],
    rejectionReason: "Symbol temporarily paused - too many consecutive losses or low win rate",
    scoreBreakdown: {},
    tradeManagementActions: [],
    management: "PAUSED"
  };
}
