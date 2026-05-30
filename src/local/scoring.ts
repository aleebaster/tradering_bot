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
  const weighted = trendStrength * 0.17 + snapshot.liquidityScore * 0.08 + volume * 0.12 + smc.score * 0.14 + mtf * 0.14 + snapshot.whaleScore * 0.07 + funding * 0.08 + oi * 0.08 + momentum * 0.12 + orderbook * 0.08 - regimePenalty - btcPenalty;
  let score = clamp(weighted);
  if (snapshot.regime === "MANIPULATION_RISK" || side === "NO_TRADE") score = Math.min(score, 55);
  const finalSide: Side = score >= 85 ? side : score >= 70 ? "WATCHLIST" : "NO_TRADE";
  const entry: [number, number] = direction >= 0 ? [last.close - a * 0.15, last.close + a * 0.1] : [last.close - a * 0.1, last.close + a * 0.15];
  const stopLoss = direction >= 0 ? Math.min(sr.support, last.close - a * 1.7) : Math.max(sr.resistance, last.close + a * 1.7);
  const takeProfit: [number, number, number] = direction >= 0 ? [last.close + a * 1.4, last.close + a * 2.4, last.close + a * 3.8] : [last.close - a * 1.4, last.close - a * 2.4, last.close - a * 3.8];
  return {
    id: `${snapshot.symbol}-${snapshot.mode}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    symbol: snapshot.symbol,
    mode: snapshot.mode,
    side: finalSide,
    score: Math.round(score),
    winProbability: Math.round(clamp(48 + score * 0.48, 0, 94)),
    confidence: Math.round(score),
    entry,
    stopLoss,
    takeProfit,
    leverage: snapshot.mode === "futures" ? (score >= 90 ? "2x-3x conservative" : "1x-2x conservative") : undefined,
    invalidationLevel: stopLoss,
    holdTime: snapshot.mode === "futures" ? "30 minutes to 6 hours" : "1 to 7 days",
    marketRegime: snapshot.regime,
    btcStable: snapshot.btcStable,
    reasons: reasons(snapshot, { trendStrength, volume, mtf, smc: smc.score, momentum, funding, oi, orderbook, rs }),
    rejectionReason: rejectionReason(finalSide, score, snapshot),
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
      btcPenalty: Math.round(btcPenalty)
    },
    management: finalSide === "NO_TRADE" ? "WAIT" : finalSide === "WATCHLIST" ? "WAIT for stronger confirmation" : "ENTER NOW; move SL to breakeven after TP1, take partial profit at TP2, trail remainder with ATR"
  };
}

function rejectionReason(side: Side, score: number, snapshot: MarketSnapshot) {
  if (side !== "NO_TRADE") return side === "WATCHLIST" ? "Score 70-84: watchlist only until stronger confirmation" : "Accepted high-probability setup";
  if (snapshot.regime === "MANIPULATION_RISK") return "Manipulation risk detected";
  if (!snapshot.btcStable && snapshot.symbol !== "BTCUSDT") return "BTC unstable, altcoin aggression blocked";
  if (snapshot.regime === "RANGING") return "Ranging/choppy market, no high-probability trend setup";
  if (snapshot.regime === "VOLATILE" || snapshot.regime === "NEWS_DRIVEN") return "Volatile/news-driven conditions, false-positive risk too high";
  return `Score ${Math.round(score)} below 70 threshold`;
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
  const out = [`Market regime: ${snapshot.regime}`, `BTC filter: ${snapshot.btcStable ? "stable" : "unstable"}`];
  if (snapshot.regime === "MANIPULATION_RISK") out.push("⚠️ HIGH RISK MARKET — NO TRADE");
  if (parts.trendStrength > 55) out.push("EMA trend structure is aligned and strong");
  if (parts.volume > 65) out.push("Volume confirmation above recent profile");
  if (parts.smc > 50) out.push("SMC confirmation from BOS/CHOCH/liquidity sweep/FVG context");
  if (parts.mtf > 65) out.push("Multi-timeframe alignment confirmed");
  if (parts.orderbook > 60) out.push("Order book imbalance supports direction");
  if (Math.abs(snapshot.fundingRate) < 0.0008) out.push("Funding is not overcrowded");
  return out;
}
