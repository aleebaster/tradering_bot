import { analyzeSmc } from "./smc";
import { atr, clamp, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "./indicators";
import type { MarketRegime, MarketSnapshot, Signal, Side } from "./types";

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
  if (volPct > 0.035 && volumeScore > 85) return "NEWS_DRIVEN";
  if (body < 0.18 && volumeScore > 90) return "MANIPULATION_RISK";
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
  const regimePenalty = snapshot.regime === "TRENDING" ? 0 : snapshot.regime === "RANGING" ? 22 : snapshot.regime === "VOLATILE" ? 18 : 35;
  const btcPenalty = snapshot.symbol === "BTCUSDT" || snapshot.btcStable ? 0 : 24;
  const confirmationPenalty = snapshot.confirmations.alignedCount >= 2 && !snapshot.confirmations.conflict ? 0 : 35;
  const weighted = trendStrength * 0.17 + snapshot.liquidityScore * 0.08 + volume * 0.12 + smc.score * 0.14 + mtf * 0.14 + snapshot.whaleScore * 0.07 + funding * 0.08 + oi * 0.08 + momentum * 0.12 + orderbook * 0.08 - regimePenalty - btcPenalty;
  let score = clamp(weighted - confirmationPenalty);
  const weakMomentum = direction !== 0 && momentum < 55;
  if (snapshot.regime === "MANIPULATION_RISK" || side === "NO_TRADE") score = Math.min(score, 55);
  if (weakMomentum) score = Math.min(score, 69);
  if (snapshot.confirmations.conflict || snapshot.confirmations.alignedCount < 2) score = Math.min(score, 69);
  const entry: [number, number] = direction >= 0 ? [last.close - a * 0.15, last.close + a * 0.1] : [last.close - a * 0.1, last.close + a * 0.15];
  const stopLoss = direction >= 0 ? Math.max(sr.support, last.close - a * 1.7) : Math.min(sr.resistance, last.close + a * 1.7);
  const takeProfit: [number, number, number] = direction >= 0 ? [last.close + a * 1.4, last.close + a * 2.4, last.close + a * 3.8] : [last.close - a * 1.4, last.close - a * 2.4, last.close - a * 3.8];
  const rrValue = riskRewardValue(entry, stopLoss, takeProfit[2], direction);
  if (rrValue < 2) score = Math.min(score, 69);
  const roundedScore = Math.round(score);
  const qualifiedSide: Side = roundedScore >= 85 ? side : "NO_TRADE";
  const entryStatus = qualifiedSide === "NO_TRADE" ? "NO_TRADE" : last.close >= Math.min(...entry) && last.close <= Math.max(...entry) ? "ENTER_NOW" : "WAIT_FOR_ENTRY";
  const riskReward = riskRewardRatio(rrValue);
  const leverage = snapshot.mode === "futures" && qualifiedSide !== "NO_TRADE" ? leverageRecommendation(score, a / last.close, momentum, snapshot.regime) : undefined;
  const management = managementText(qualifiedSide, entryStatus);
  return {
    id: `${snapshot.symbol}-${snapshot.mode}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: snapshot.symbol,
    mode: snapshot.mode,
    side: qualifiedSide,
    score: roundedScore,
    winProbability: Math.round(clamp(48 + score * 0.48, 0, 94)),
    confidence: Math.round(score),
    currentPrice: last.close,
    entryStatus,
    entry,
    stopLoss,
    takeProfit,
    leverage,
    riskReward,
    invalidationLevel: stopLoss,
    holdTime: snapshot.mode === "futures" ? "30 хвилин до 6 годин" : "1-7 днів",
    marketRegime: snapshot.regime,
    btcStable: snapshot.btcStable,
    confirmations: snapshot.confirmations,
    reasons: reasons(snapshot, { trendStrength, volume, mtf, smc: smc.score, momentum, funding, oi, orderbook, rs }),
    rejectionReason: rejectionReason(qualifiedSide, roundedScore, snapshot, weakMomentum, rrValue),
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
      regimePenalty: Math.round(regimePenalty),
      btcPenalty: Math.round(btcPenalty),
      exchangeConfirmationPenalty: Math.round(confirmationPenalty)
    },
    tradeManagementActions: tradeManagementActions(qualifiedSide, entryStatus),
    management
  };
}

function rejectionReason(side: Side, score: number, snapshot: MarketSnapshot, weakMomentum: boolean, rrValue: number) {
  if (side !== "NO_TRADE") return "Прийнятий сетап з високою ймовірністю";
  if (snapshot.regime === "MANIPULATION_RISK") return "Виявлено ризик маніпуляції";
  if (!snapshot.btcStable && snapshot.symbol !== "BTCUSDT") return "BTC нестабільний, агресивні угоди по альткоїнах заблоковані";
  if (snapshot.confirmations.conflict) return "Біржові підтвердження конфліктують, угоду пропущено";
  if (snapshot.confirmations.alignedCount < 2) return "Недостатньо підтверджень з бірж, потрібно мінімум 2 джерела";
  if (weakMomentum) return "Слабкий імпульс, угоду пропущено";
  if (rrValue < 2) return `Співвідношення ризик/прибуток ${riskRewardRatio(rrValue)} нижче мінімуму 1:2.0`;
  if (snapshot.regime === "RANGING") return "Боковий/шумний ринок, немає сильного трендового сетапу";
  if (snapshot.regime === "VOLATILE" || snapshot.regime === "NEWS_DRIVEN") return "Волатильний або новинний ринок, ризик хибного сигналу занадто високий";
  return `Оцінка ${Math.round(score)} нижче порогу високої якості 85`;
}

function leverageRecommendation(score: number, volatility: number, momentum: number, regime: MarketRegime) {
  let leverage = score >= 90 ? 5 : score >= 85 ? 3 : 2;
  if (volatility > 0.018 || regime === "VOLATILE" || regime === "NEWS_DRIVEN") leverage = Math.min(leverage, 2);
  else if (volatility > 0.012 || momentum < 70) leverage = Math.min(leverage, 3);
  if (score < 90) leverage = Math.min(leverage, 3);
  if (score < 85) leverage = 2;
  return `${leverage}x`;
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
  if (entryStatus === "WAIT_FOR_ENTRY") return "⏳ ЧЕКАТИ ЗОНУ ВХОДУ";
  return "✅ ЗАХОДИТИ ЗАРАЗ; після TP1 перенести SL у беззбиток, на TP2 зафіксувати частину, залишок вести трейлінгом ATR";
}

function tradeManagementActions(side: Side, entryStatus: Signal["entryStatus"]) {
  if (side === "NO_TRADE") return ["❌ НЕ ВХОДИТИ"];
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

function reasons(snapshot: MarketSnapshot, parts: Record<string, number>) {
  const out = [`Режим ринку: ${marketRegimeUa(snapshot.regime)}`, `Фільтр BTC: ${snapshot.btcStable ? "стабільний" : "нестабільний"}`];
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
  const map: Record<MarketRegime, string> = { TRENDING: "трендовий", RANGING: "боковий", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}
