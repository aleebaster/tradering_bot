import { ExchangeClient } from "./exchanges";
import { marketHealth, resolvePair, type MarketRegistryItem } from "./marketRegistry";
import type { Candle } from "./types";

const client = new ExchangeClient();

export type SpotForecast = {
  symbol: string;
  marketType: "spot";
  shortTerm: { scalping: string; intraday: string; swing: string; confidence: number };
  longTerm: { bias: string; confidence: number; accumulationZone: [number, number]; resistance: [number, number]; growthPotential: string; riskProfile: string; marketCycle: string; volatilityExpectation: string };
  suitability: { shortTermTrade: boolean; midTermHold: boolean; longTermInvestment: boolean };
  metrics: { price: number; volume24h: number; liquidity: number; spreadPct: number; volatilityPct: number; trendScore: number; momentumScore: number; whaleScore: number; btcCorrelation: number; health: ReturnType<typeof marketHealth> };
  reasons: string[];
};

export async function analyzeSpot(query: string): Promise<SpotForecast> {
  const resolved = await resolvePair(query);
  const market = resolved.spot[0] ?? resolved.suggestions.find((item) => item.marketType === "spot");
  if (!market) throw new Error(`Spot pair not found for ${query}`);
  const [candles, btcCandles, orderBook] = await Promise.all([
    loadSpotCandles(market.symbol),
    loadSpotCandles("BTCUSDT"),
    client.bybitOrderBookStats(market.symbol, "spot").catch(() => ({ spreadPct: market.spreadPct, depthUsdt: 0, imbalance: 0, spoofRisk: false }))
  ]);
  return buildSpotForecast(market, candles, btcCandles, orderBook.imbalance);
}

export async function loadSpotCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["15", "60", "240", "D"]) out[tf] = await client.bybitKlines(symbol, tf, "spot", tf === "D" ? 220 : 180);
  return out;
}

function buildSpotForecast(market: MarketRegistryItem, candles: Record<string, Candle[]>, btcCandles: Record<string, Candle[]>, whaleImbalance: number): SpotForecast {
  const h1 = candles["60"];
  const h4 = candles["240"];
  const d = candles.D;
  const last = h1.at(-1)!;
  const price = last.close;
  const trendScore = trend(h4) * 0.45 + trend(d) * 0.55;
  const momentumScore = momentum(h1);
  const volatilityPct = atrPct(h4);
  const btcCorrelation = correlation(h1, btcCandles["60"] ?? []);
  const whaleScore = Math.round(Math.min(100, Math.max(0, 50 + whaleImbalance * 80 + volumeBias(h1) * 20)));
  const health = marketHealth(market);
  const risk = riskProfile(volatilityPct, health.score, market.spreadPct);
  const shortConfidence = clamp(trendScore * 0.3 + momentumScore * 0.35 + health.score * 0.2 + whaleScore * 0.15);
  const longConfidence = clamp(trendScore * 0.4 + health.score * 0.25 + whaleScore * 0.2 + (100 - Math.min(100, volatilityPct * 1800)) * 0.15);
  const support = supportZone(d);
  const resistance = resistanceZone(d);
  const accumulation = accumulationZone(d, support, price);
  const cycle = marketCycle(trendScore, price, support, resistance);
  const reasons = [
    `Trend score ${Math.round(trendScore)}/100 across 4H/D`,
    `Momentum ${Math.round(momentumScore)}/100 with volatility ${(volatilityPct * 100).toFixed(2)}%`,
    `Liquidity health ${health.score}/100, spread ${(market.spreadPct * 100).toFixed(3)}%`,
    `Smart money/whale proxy ${whaleScore}/100`,
    `BTC correlation ${btcCorrelation.toFixed(2)}`
  ];

  return {
    symbol: market.symbol,
    marketType: "spot",
    shortTerm: {
      scalping: label(shortConfidence, momentumScore),
      intraday: label(shortConfidence, trendScore),
      swing: label((shortConfidence + longConfidence) / 2, trendScore),
      confidence: Math.round(shortConfidence)
    },
    longTerm: {
      bias: label(longConfidence, trendScore),
      confidence: Math.round(longConfidence),
      accumulationZone: accumulation,
      resistance,
      growthPotential: growthPotential(price, resistance, longConfidence),
      riskProfile: risk,
      marketCycle: cycle,
      volatilityExpectation: volatilityPct > 0.035 ? "High" : volatilityPct > 0.018 ? "Medium" : "Low/Compressed"
    },
    suitability: {
      shortTermTrade: shortConfidence >= 68 && health.score >= 55 && risk !== "Extreme",
      midTermHold: longConfidence >= 62 && trendScore >= 55 && health.score >= 55,
      longTermInvestment: longConfidence >= 70 && trendScore >= 62 && risk !== "Extreme"
    },
    metrics: { price, volume24h: market.turnover24h, liquidity: market.liquidity, spreadPct: market.spreadPct, volatilityPct, trendScore: Math.round(trendScore), momentumScore: Math.round(momentumScore), whaleScore, btcCorrelation, health },
    reasons
  };
}

function trend(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const last = closes.at(-1) ?? 0;
  return clamp((last > e20 ? 20 : 0) + (e20 > e50 ? 35 : 10) + (e50 > e100 ? 30 : 10) + slope(closes) * 1200 + 10);
}

function momentum(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const change = ((closes.at(-1)! - closes.at(-12)!) / closes.at(-12)!) * 100;
  return clamp(50 + change * 8);
}

function atrPct(candles: Candle[], period = 14) {
  const slice = candles.slice(-period - 1);
  const trs = slice.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - slice[i].close), Math.abs(c.low - slice[i].close)));
  const atr = trs.reduce((s, x) => s + x, 0) / Math.max(trs.length, 1);
  return atr / Math.max(slice.at(-1)?.close ?? 1, 1e-9);
}

function supportZone(candles: Candle[]): [number, number] {
  const lows = candles.slice(-80).map((c) => c.low).sort((a, b) => a - b);
  const low = lows[Math.floor(lows.length * 0.12)] ?? lows[0];
  return [low * 0.992, low * 1.012];
}

function resistanceZone(candles: Candle[]): [number, number] {
  const highs = candles.slice(-80).map((c) => c.high).sort((a, b) => a - b);
  const high = highs[Math.floor(highs.length * 0.88)] ?? highs.at(-1)!;
  return [high * 0.988, high * 1.012];
}

function accumulationZone(candles: Candle[], support: [number, number], price: number): [number, number] {
  const avg = candles.slice(-30).reduce((sum, c) => sum + c.close, 0) / 30;
  return price <= avg ? [support[0], Math.min(support[1] * 1.03, avg)] : support;
}

function correlation(a: Candle[], b: Candle[]) {
  const n = Math.min(a.length, b.length, 80);
  if (n < 20) return 0;
  const ar = returns(a.slice(-n));
  const br = returns(b.slice(-n));
  const am = mean(ar), bm = mean(br);
  const cov = ar.reduce((s, x, i) => s + (x - am) * (br[i] - bm), 0);
  const av = Math.sqrt(ar.reduce((s, x) => s + (x - am) ** 2, 0));
  const bv = Math.sqrt(br.reduce((s, x) => s + (x - bm) ** 2, 0));
  return av && bv ? cov / (av * bv) : 0;
}

function volumeBias(candles: Candle[]) {
  const recent = candles.slice(-8).reduce((s, c) => s + c.volume, 0) / 8;
  const base = candles.slice(-40, -8).reduce((s, c) => s + c.volume, 0) / 32;
  return base ? Math.min(2, recent / base) - 1 : 0;
}

function riskProfile(volatilityPct: number, health: number, spreadPct: number) {
  if (health < 35 || spreadPct > 0.01 || volatilityPct > 0.07) return "Extreme";
  if (health < 55 || volatilityPct > 0.035) return "High";
  if (volatilityPct > 0.018) return "Medium";
  return "Moderate";
}

function marketCycle(trendScore: number, price: number, support: [number, number], resistance: [number, number]) {
  if (price <= support[1] * 1.05 && trendScore >= 45) return "Accumulation/Re-accumulation";
  if (trendScore >= 70) return "Expansion uptrend";
  if (price >= resistance[0] * 0.98) return "Distribution/resistance test";
  return "Neutral range";
}

function growthPotential(price: number, resistance: [number, number], confidence: number) {
  const pct = ((resistance[0] - price) / price) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% to major resistance; confidence ${Math.round(confidence)}%`;
}

function label(confidence: number, directionScore: number) {
  if (confidence >= 72 && directionScore >= 58) return `Bullish (${Math.round(confidence)}%)`;
  if (confidence <= 38 && directionScore <= 45) return `Bearish (${Math.round(100 - confidence)}%)`;
  return `Neutral/Bullish (${Math.round(confidence)}%)`;
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  return values.reduce((prev, value, index) => index === 0 ? value : value * k + prev * (1 - k), values[0] ?? 0);
}

function slope(values: number[]) {
  const a = values.at(-1) ?? 0;
  const b = values.at(-20) ?? a;
  return (a - b) / Math.max(b, 1e-9);
}

function returns(candles: Candle[]) {
  return candles.slice(1).map((c, i) => (c.close - candles[i].close) / candles[i].close);
}

function mean(values: number[]) {
  return values.reduce((s, x) => s + x, 0) / Math.max(values.length, 1);
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}
