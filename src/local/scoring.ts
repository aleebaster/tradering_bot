import { analyzeSmc } from "./smc";
import { atr, clamp, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "./indicators";
import { calculatePositionSizing } from "./positionSizing";
import { config } from "./config";
import { adaptiveWeights } from "./learning";
import type { AccuracyRisk, AccuracySession, Candle, CorrelationContext, FakeBreakoutAnalysis, HigherTimeframeBias, LiquidityIntelligence, MarketRegime, MarketSnapshot, OpenInterestAnalysis, OrderFlowAnalysis, Signal, SignalGrade, Side } from "./types";

export function regimeFrom(candles: MarketSnapshot["candles"]): MarketRegime {
  const base = candles["60"] ?? candles["15"] ?? [];
  if (base.length < 80) return "RANGING";
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
  const compression = atrPrev > 0 && atrNow / atrPrev < 0.72;
  const expansion = atrPrev > 0 && atrNow / atrPrev > 1.35 && volumeScore > 65;
  if (volPct > 0.035 && volumeScore > 85) return "NEWS_DRIVEN";
  if (body < 0.18 && volumeScore > 90) return "MANIPULATION_RISK";
  if (compression) return "COMPRESSION";
  if (expansion) return "EXPANSION";
  if (volPct > 0.025) return "VOLATILE";
  if ((e20 > e50 && e50 > e200) || (e20 < e50 && e50 < e200)) return "TRENDING";
  return "RANGING";
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

export function buildSignal(snapshot: MarketSnapshot): Signal {
  const primaryTf = snapshot.mode === "futures" ? "15" : "240";
  const candles = snapshot.candles[primaryTf] ?? [];
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
  const trendUp = e20 > e50 && e50 > e200 && last.close > vw;
  const trendDown = e20 < e50 && e50 < e200 && last.close < vw;
  const side: Side = snapshot.mode === "spot" ? (trendUp ? "BUY" : "NO_TRADE") : trendUp ? "LONG" : trendDown ? "SHORT" : "NO_TRADE";
  const direction = side === "SHORT" ? -1 : side === "NO_TRADE" ? 0 : 1;
  const trendStrength = clamp(Math.abs(e20 - e50) / Math.max(a, 1e-9) * 25);
  const momentum = direction === 1 ? clamp((m.histogram > 0 ? 55 : 35) + (rs > 52 && rs < 72 ? 25 : 0)) : direction === -1 ? clamp((m.histogram < 0 ? 55 : 35) + (rs < 48 && rs > 28 ? 25 : 0)) : 0;
  const mtf = multiTimeframeScore(snapshot, direction);
  const volume = volumeProfileScore(candles);
  const funding = snapshot.mode === "futures" ? clamp(100 - Math.abs(snapshot.fundingRate) * 10000) : 70;
  const oi = clamp(50 + snapshot.openInterestChange * 1000 * direction);
  const orderbook = clamp(50 + snapshot.orderBookImbalance * 120 * direction);
  const session = sessionFilter(new Date());
  const newsRisk = highImpactNewsRisk(snapshot, last, a);
  const htf = higherTimeframeBias(snapshot.candles, direction);
  const liquidity = liquidityIntelligence(candles, direction);
  const orderFlow = orderFlowAnalysis(candles, direction);
  const oiAnalysis = openInterestAnalysis(snapshot.openInterestChange, last, candles.at(-8), direction);
  const fakeBreakout = fakeBreakoutAnalysis(candles, direction, volume, oiAnalysis, snapshot.btcStable, snapshot.regime);
  const correlation = snapshot.correlation ?? neutralCorrelation();
  const learned = adaptiveWeights();
  const regimePenalty = snapshot.regime === "TRENDING" || snapshot.regime === "EXPANSION" ? 0 : snapshot.regime === "COMPRESSION" ? 12 : snapshot.regime === "RANGING" ? 28 : snapshot.regime === "VOLATILE" ? 22 : 40;
  const btcPenalty = snapshot.symbol === "BTCUSDT" || snapshot.btcStable ? 0 : 24;
  const confirmationPenalty = snapshot.confirmations.alignedCount >= 2 && !snapshot.confirmations.conflict ? 0 : 35;
  const advancedBonus = htf.score * 0.16 * learned.htf + liquidity.score * 0.08 * learned.liquidity + orderFlow.score * 0.11 * learned.orderFlow + oiAnalysis.score * 0.09 * learned.oi + fakeBreakout.score * 0.12 + (correlation.aligned ? 8 : correlation.riskOff ? -18 : 0) + session.confidenceAdjustment;
  const weighted = trendStrength * 0.12 + snapshot.liquidityScore * 0.06 + volume * 0.1 * learned.volume + smc.score * 0.13 * learned.smc + mtf * 0.1 + snapshot.whaleScore * 0.05 + funding * 0.05 + oi * 0.04 + momentum * 0.09 * learned.macd + orderbook * 0.06 + advancedBonus - regimePenalty - btcPenalty;
  let score = clamp(weighted - confirmationPenalty);
  const weakMomentum = direction !== 0 && momentum < 55;
  const hardBlock = accuracyHardBlock(snapshot, { side, direction, session, newsRisk, htf, liquidity, orderFlow, oiAnalysis, fakeBreakout, correlation });
  if (snapshot.regime === "MANIPULATION_RISK" || side === "NO_TRADE") score = Math.min(score, 55);
  if (weakMomentum) score = Math.min(score, 69);
  if (snapshot.confirmations.conflict || snapshot.confirmations.alignedCount < 2) score = Math.min(score, 69);
  if (hardBlock.blocked) score = Math.min(score, hardBlock.maxScore);
  const entry: [number, number] = direction >= 0 ? [last.close - a * 0.15, last.close + a * 0.1] : [last.close - a * 0.1, last.close + a * 0.15];
  const stopLoss = direction >= 0 ? Math.max(sr.support, last.close - a * 1.7) : Math.min(sr.resistance, last.close + a * 1.7);
  const takeProfit: [number, number, number] = direction >= 0 ? [last.close + a * 1.4, last.close + a * 2.4, last.close + a * 3.8] : [last.close - a * 1.4, last.close - a * 2.4, last.close - a * 3.8];
  const rrValue = riskRewardValue(entry, stopLoss, takeProfit[2], direction);
  if (rrValue < 2) score = Math.min(score, 69);
  const roundedScore = Math.round(score);
  const qualifiedSide: Side = roundedScore >= 85 ? side : roundedScore >= 80 && snapshot.mode === "futures" && side !== "NO_TRADE" ? "WATCHLIST" : "NO_TRADE";
  const entryStatus = qualifiedSide === "NO_TRADE" || qualifiedSide === "WATCHLIST" ? "NO_TRADE" : last.close >= Math.min(...entry) && last.close <= Math.max(...entry) ? "ENTER_NOW" : "WAIT_FOR_ENTRY";
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
    momentumScore: momentum
  });
  const management = managementText(qualifiedSide, entryStatus);
  return {
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
    reasons: reasons(snapshot, { trendStrength, volume, mtf, smc: smc.score, momentum, funding, oi, orderbook, rs }, { session, newsRisk, htf, liquidity, orderFlow, oiAnalysis, fakeBreakout, correlation }),
    rejectionReason: rejectionReason(qualifiedSide, roundedScore, snapshot, weakMomentum, rrValue, hardBlock.reason),
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
      liquiditySweep: Math.round(liquidity.score),
      cvdOrderFlow: Math.round(orderFlow.score),
      smartOpenInterest: Math.round(oiAnalysis.score),
      fakeBreakoutProtection: Math.round(fakeBreakout.score),
      sessionQuality: session.confidenceAdjustment,
      regimePenalty: Math.round(regimePenalty),
      btcPenalty: Math.round(btcPenalty),
      exchangeConfirmationPenalty: Math.round(confirmationPenalty)
    },
    tradeManagementActions: tradeManagementActions(qualifiedSide, entryStatus),
    management
  };
}

function rejectionReason(side: Side, score: number, snapshot: MarketSnapshot, weakMomentum: boolean, rrValue: number, hardBlockReason?: string) {
  if (side !== "NO_TRADE") return "Прийнятий сетап з високою ймовірністю";
  if (hardBlockReason) return hardBlockReason;
  if (score >= 80 && score < 85 && snapshot.mode === "futures") return "WATCHLIST ONLY: сетап близько до порогу, потрібне покращення підтверджень";
  if (snapshot.regime === "MANIPULATION_RISK") return "Виявлено ризик маніпуляції";
  if (!snapshot.btcStable && snapshot.symbol !== "BTCUSDT") return "BTC нестабільний, агресивні угоди по альткоїнах заблоковані";
  if (snapshot.confirmations.conflict) return "Біржові підтвердження конфліктують, угоду пропущено";
  if (snapshot.confirmations.alignedCount < 2) return "Недостатньо підтверджень з бірж, потрібно мінімум 2 джерела";
  if (weakMomentum) return "Слабкий імпульс, угоду пропущено";
  if (rrValue < 2) return `Співвідношення ризик/прибуток ${riskRewardRatio(rrValue)} нижче мінімуму 1:2.0`;
  if (snapshot.regime === "RANGING") return "Боковий/шумний ринок, немає сильного трендового сетапу";
  if (snapshot.regime === "COMPRESSION") return "COMPRESSION режим: ринок стислий, breakout ще не підтверджений";
  if (snapshot.regime === "VOLATILE" || snapshot.regime === "NEWS_DRIVEN") return "Волатильний або новинний ринок, ризик хибного сигналу занадто високий";
  return `Оцінка ${Math.round(score)} нижче порогу високої якості 85`;
}

function leverageRecommendation(score: number, volatility: number, momentum: number, regime: MarketRegime) {
  let leverage = score >= 90 ? 5 : score >= 85 ? 3 : 2;
  if (volatility > 0.018 || regime === "VOLATILE" || regime === "NEWS_DRIVEN") leverage = Math.min(leverage, 2);
  else if (volatility > 0.012 || momentum < 70) leverage = Math.min(leverage, 3);
  if (score < 90) leverage = Math.min(leverage, 3);
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

function managementText(side: Side, entryStatus: Signal["entryStatus"]) {
  if (side === "NO_TRADE") return "❌ НЕ ВХОДИТИ";
  if (side === "WATCHLIST") return "⚠️ WATCHLIST ONLY";
  if (entryStatus === "WAIT_FOR_ENTRY") return "⏳ ЧЕКАТИ ЗОНУ ВХОДУ";
  return "✅ ЗАХОДИТИ ЗАРАЗ; після TP1 перенести SL у беззбиток, на TP2 зафіксувати частину, залишок вести трейлінгом ATR";
}

function tradeManagementActions(side: Side, entryStatus: Signal["entryStatus"]) {
  if (side === "NO_TRADE") return ["❌ НЕ ВХОДИТИ"];
  if (side === "WATCHLIST") return ["⚠️ WATCHLIST ONLY"];
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

function reasons(snapshot: MarketSnapshot, parts: Record<string, number>, advanced: { session: AccuracySession; newsRisk: AccuracyRisk; htf: HigherTimeframeBias; liquidity: LiquidityIntelligence; orderFlow: OrderFlowAnalysis; oiAnalysis: OpenInterestAnalysis; fakeBreakout: FakeBreakoutAnalysis; correlation: CorrelationContext }) {
  const out = [`Режим ринку: ${marketRegimeUa(snapshot.regime)}`, `Фільтр BTC: ${snapshot.btcStable ? "стабільний" : "нестабільний"}`];
  out.push(advanced.session.message);
  if (advanced.newsRisk.blocked) out.push(advanced.newsRisk.message);
  if (!advanced.htf.aligned) out.push("4H/Daily не підтверджують нижчий таймфрейм");
  else out.push("5m/15m/1H/4H/Daily узгоджені з напрямком");
  out.push(advanced.liquidity.message, advanced.orderFlow.message, advanced.oiAnalysis.message);
  if (advanced.fakeBreakout.risk) out.push(advanced.fakeBreakout.message);
  if (!advanced.correlation.aligned) out.push(`Кореляційний фільтр: ${advanced.correlation.details.join("; ")}`);
  if (snapshot.regime === "MANIPULATION_RISK") out.push("⚠️ РИНОК ВИСОКОГО РИЗИКУ — НЕ ВХОДИТИ");
  if (parts.trendStrength > 55) out.push("структура EMA підтверджує сильний тренд");
  if (parts.volume > 65) out.push("обсяг підтверджує рух вище недавнього профілю");
  if (parts.smc > 50) out.push("SMC підтверджено через BOS/CHOCH/liquidity sweep/FVG");
  if (parts.mtf > 65) out.push("мультитаймфрейм підтверджує напрямок");
  if (parts.orderbook > 60) out.push("дисбаланс стакана підтримує напрямок");
  if (Math.abs(snapshot.fundingRate) < 0.0008) out.push("funding не перегрітий");
  if (snapshot.confirmations.alignedCount >= 2) out.push(`підтверджено біржами: ${confirmedBy(snapshot).join(", ")}`);
  return out;
}

function confirmedBy(snapshot: MarketSnapshot) {
  return [snapshot.confirmations.bybit ? "Bybit" : "", snapshot.confirmations.okx ? "OKX" : "", snapshot.confirmations.kucoin ? "KuCoin" : "", snapshot.confirmations.kraken ? "Kraken" : "", snapshot.confirmations.binance ? "Binance" : ""].filter(Boolean);
}

function marketRegimeUa(regime: MarketRegime) {
  const map: Record<MarketRegime, string> = { TRENDING: "трендовий", RANGING: "боковий", EXPANSION: "розширення волатильності", COMPRESSION: "стиснення волатильності", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}

function sessionFilter(now: Date): AccuracySession {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minutes = hour * 60 + minute;
  if (minutes >= 420 && minutes <= 570) return { name: "LONDON_OPEN", active: true, confidenceAdjustment: 6, message: "✅ London Open: ліквідність активна" };
  if (minutes >= 780 && minutes <= 960) return { name: "LONDON_NY_OVERLAP", active: true, confidenceAdjustment: 8, message: "✅ London + NY overlap: найкраща ліквідність" };
  if (minutes >= 780 && minutes <= 930) return { name: "NEW_YORK_OPEN", active: true, confidenceAdjustment: 7, message: "✅ New York Open: ліквідність активна" };
  if (minutes >= 0 && minutes <= 360) return { name: "ASIA_CHOP", active: false, confidenceAdjustment: -18, message: "⚠️ LOW LIQUIDITY SESSION — WAIT" };
  return { name: "OFF_HOURS", active: false, confidenceAdjustment: -10, message: "⚠️ Поза головними сесіями — знижена впевненість" };
}

function highImpactNewsRisk(snapshot: MarketSnapshot, last: Candle, a: number): AccuracyRisk {
  const manualUntil = config.HIGH_IMPACT_NEWS_BLOCK_UNTIL ? Date.parse(config.HIGH_IMPACT_NEWS_BLOCK_UNTIL) : 0;
  const reasons: string[] = [];
  if (manualUntil && manualUntil > Date.now()) reasons.push(`manual news block до ${new Date(manualUntil).toISOString()}`);
  if (snapshot.regime === "NEWS_DRIVEN") reasons.push("NEWS_DRIVEN режим за ATR/volume");
  if (a / last.close > 0.035) reasons.push("macro volatility spike за ATR");
  const nfpWindow = isFirstFridayNfpWindow(new Date());
  if (nfpWindow) reasons.push("можливе NFP/Fed macro window");
  return { blocked: reasons.length > 0, severity: reasons.length ? "HIGH" : "LOW", message: reasons.length ? "⚠️ HIGH IMPACT NEWS RISK — NO TRADE" : "✅ Немає активного high-impact news block", reasons };
}

function isFirstFridayNfpWindow(now: Date) {
  const day = now.getUTCDay();
  const date = now.getUTCDate();
  const hour = now.getUTCHours();
  return day === 5 && date <= 7 && hour >= 11 && hour <= 15;
}

function higherTimeframeBias(candles: Record<string, Candle[]>, direction: number): HigherTimeframeBias {
  if (direction === 0) return { direction: 0, aligned: false, score: 0, details: ["немає напрямку lower timeframe"] };
  const frames = ["5", "15", "60", "240", "D"];
  const dirs = frames.map((tf) => [tf, trendDirection(candles[tf])] as const);
  const htfDirs = dirs.filter(([tf]) => tf === "240" || tf === "D");
  const alignedCount = dirs.filter(([, dir]) => dir === direction).length;
  const htfAligned = htfDirs.every(([, dir]) => dir === 0 || dir === direction) && htfDirs.some(([, dir]) => dir === direction);
  return { direction, aligned: htfAligned && alignedCount >= 4, score: htfAligned ? alignedCount / frames.length * 100 : 0, details: dirs.map(([tf, dir]) => `${tf}: ${dir > 0 ? "LONG" : dir < 0 ? "SHORT" : "NEUTRAL"}`) };
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
  const message = sweptAbove ? "✅ Liquidity above swept: SHORT confirmation" : sweptBelow ? "✅ Liquidity below swept: LONG confirmation" : "⚠️ Немає чистого liquidity sweep confirmation";
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
  return { cvd, direction: cvdDirection, score, trapRisk, message: trapRisk ? "⚠️ CVD divergence: trap risk" : cvdDirection === direction ? "✅ CVD/order flow підтримує напрямок" : "⚠️ CVD не дає сильного підтвердження" };
}

function openInterestAnalysis(oiChange: number, last: Candle, previous: Candle | undefined, direction: number): OpenInterestAnalysis {
  const priceDir = previous ? (last.close > previous.close ? 1 : last.close < previous.close ? -1 : 0) : direction;
  const oiDir = oiChange > 0.001 ? 1 : oiChange < -0.001 ? -1 : 0;
  if (priceDir === 1 && oiDir === 1) return { direction: 1, score: direction === 1 ? 100 : 10, message: "✅ Price ↑ + OI ↑: strong long continuation" };
  if (priceDir === 1 && oiDir === -1) return { direction: 0, score: 35, message: "⚠️ Price ↑ + OI ↓: short covering / weak move" };
  if (priceDir === -1 && oiDir === 1) return { direction: -1, score: direction === -1 ? 100 : 10, message: "✅ Price ↓ + OI ↑: strong short pressure" };
  if (priceDir === -1 && oiDir === -1) return { direction: 0, score: 35, message: "⚠️ Price ↓ + OI ↓: weak bearish move" };
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
  if (regime === "MANIPULATION_RISK") reasons.push("manipulated move risk");
  const risk = reasons.length >= 2;
  return { risk, score: risk ? 0 : 85, reasons, message: risk ? "⚠️ FAKE BREAKOUT RISK — WAIT" : "✅ Fake breakout risk low" };
}

function accuracyHardBlock(snapshot: MarketSnapshot, input: { side: Side; direction: number; session: AccuracySession; newsRisk: AccuracyRisk; htf: HigherTimeframeBias; liquidity: LiquidityIntelligence; orderFlow: OrderFlowAnalysis; oiAnalysis: OpenInterestAnalysis; fakeBreakout: FakeBreakoutAnalysis; correlation: CorrelationContext }) {
  if (input.newsRisk.blocked) return { blocked: true, maxScore: 55, reason: input.newsRisk.message };
  if (!input.session.active) return { blocked: true, maxScore: 79, reason: input.session.message };
  if (!input.htf.aligned && input.direction !== 0) return { blocked: true, maxScore: 79, reason: "4H/Daily bias конфліктує з нижчим таймфреймом" };
  if (input.fakeBreakout.risk) return { blocked: true, maxScore: 79, reason: input.fakeBreakout.message };
  if (input.orderFlow.trapRisk) return { blocked: true, maxScore: 79, reason: "CVD показує trap risk, вхід заблоковано" };
  if (snapshot.symbol !== "BTCUSDT" && input.direction === 1 && (input.correlation.riskOff || !input.correlation.aligned)) return { blocked: true, maxScore: 79, reason: "Кореляційний фільтр не підтвердив altcoin LONG" };
  if (snapshot.symbol !== "BTCUSDT" && input.direction === -1 && input.correlation.aligned && !input.correlation.riskOff) return { blocked: true, maxScore: 79, reason: "Кореляційний фільтр не підтвердив altcoin SHORT" };
  if (snapshot.regime === "RANGING" && input.side !== "WATCHLIST") return { blocked: true, maxScore: 79, reason: "RANGING market: trend breakout entries заблоковані" };
  return { blocked: false, maxScore: 100, reason: undefined };
}

function gradeFrom(score: number, blocked: boolean, side: Side): SignalGrade {
  if (blocked || side === "NO_TRADE") return "D";
  if (side === "WATCHLIST") return "C";
  if (score >= 92) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "B";
  return "D";
}

function signalTtlMs(score: number) {
  if (score >= 90) return 30 * 60 * 1000;
  if (score >= 85) return 20 * 60 * 1000;
  return 15 * 60 * 1000;
}

function neutralCorrelation(): CorrelationContext {
  return { btcDirection: 0, ethDirection: 0, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: false, riskOff: false, details: ["correlation data unavailable"] };
}
