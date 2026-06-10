import { ExchangeClient } from "./exchanges";
import { atr, clamp, ema, macd, rsi, volumeProfileScore } from "./indicators";
import type { Candle } from "./types";

type Direction = "Bullish" | "Neutral" | "Bearish";

type TimeframeForecast = {
  timeframe: "1H" | "4H" | "1D";
  direction: Direction;
  probability: number;
  trend: number;
  bullishProbability: number;
  bearishProbability: number;
  rsi: number;
  emaStructure: "bullish" | "neutral" | "bearish";
  volatility: number;
  marketStructure: "HH/HL" | "range" | "LH/LL";
};

export type BtcForecast = {
  price: number;
  trendStrength: number;
  frames: TimeframeForecast[];
  reasons: string[];
  warnings: string[];
  recommendation: string[];
  market: {
    trend: "Strong Bull" | "Sideways" | "Weak";
    volatility: "Low" | "Medium" | "High";
    risk: "Safe" | "Medium" | "Aggressive";
    scalp: "Allowed" | "Caution" | "Avoid";
    swing: "Preferred" | "Allowed" | "Avoid";
    altcoins: string;
  };
  metrics: {
    btcDominance: number;
    btcDominanceTrend: "rising" | "flat" | "falling";
    fundingRate: number;
    openInterestChange: number;
    liquidationPressure: number;
    orderbookImbalance: number;
  };
  updatedAt: string;
  latencyMs: number;
};

const CACHE_MS = 45_000;
let cache: { expiresAt: number; value: BtcForecast } | null = null;
const client = new ExchangeClient();

export async function getBtcForecast(): Promise<BtcForecast> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const startedAt = Date.now();
  const [h1, h4, d1, orderBook, fundingRate, openInterestChange, globalMarket] = await Promise.all([
    client.bybitKlines("BTCUSDT", "60", "linear", 140),
    client.bybitKlines("BTCUSDT", "240", "linear", 140),
    client.bybitKlines("BTCUSDT", "D", "linear", 120),
    client.bybitOrderBookStats("BTCUSDT").catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    client.fundingRate("BTCUSDT").catch(() => 0),
    client.openInterestChange("BTCUSDT").catch(() => 0),
    fetchGlobalCryptoMarket().catch(() => null)
  ]);
  const price = h1.at(-1)?.close ?? h4.at(-1)?.close ?? d1.at(-1)?.close ?? 0;
  const btcDominance = globalMarket?.btcDominance ?? 0;
  const btcDominanceTrend = dominanceTrend(globalMarket?.btcDominance, contextsPerformance(h1, h4, d1));
  const liquidationPressure = liquidationPressureScore(orderBook.imbalance, fundingRate, openInterestChange, orderBook.spoofRisk);
  const contexts = [frameForecast("1H", h1, orderBook.imbalance, fundingRate, openInterestChange), frameForecast("4H", h4, orderBook.imbalance, fundingRate, openInterestChange), frameForecast("1D", d1, orderBook.imbalance, fundingRate, openInterestChange)];
  const trendStrength = Math.round(contexts.reduce((sum, item) => sum + item.strength, 0) / Math.max(contexts.length, 1));
  const reasons = btcReasons(contexts, orderBook.imbalance, fundingRate, openInterestChange);
  const warnings = btcWarnings(contexts, orderBook.spreadPct, fundingRate, orderBook.spoofRisk);
  const market = btcMarketState(contexts, h1, trendStrength);
  const value: BtcForecast = {
    price,
    trendStrength,
    frames: contexts.map(({ timeframe, direction, probability, trend, bullishProbability, bearishProbability, rsiValue, emaStructure, volatilityPct, structureLabel }) => ({ timeframe, direction, probability, trend, bullishProbability, bearishProbability, rsi: Math.round(rsiValue), emaStructure, volatility: Number((volatilityPct * 100).toFixed(2)), marketStructure: structureLabel })),
    reasons,
    warnings,
    recommendation: btcRecommendation(contexts, market),
    market,
    metrics: { btcDominance, btcDominanceTrend, fundingRate, openInterestChange, liquidationPressure, orderbookImbalance: orderBook.imbalance },
    updatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt
  };
  cache = { expiresAt: Date.now() + CACHE_MS, value };
  return value;
}

export function formatBtcForecast(forecast: BtcForecast) {
  return [
    "📈 Bitcoin Forecast",
    "",
    `BTC: $${formatPrice(forecast.price)}`,
    "",
    ...forecast.frames.map((frame) => `${frame.timeframe}: ${directionIcon(frame.direction)} ${frame.direction} trend ${frame.trend}% | bull ${frame.bullishProbability}% / bear ${frame.bearishProbability}%`),
    "",
    `Сила тренду: ${forecast.trendStrength}%`,
    `BTC dominance: ${forecast.metrics.btcDominance ? `${forecast.metrics.btcDominance.toFixed(2)}% (${forecast.metrics.btcDominanceTrend})` : "немає live даних"}`,
    `OI: ${formatPercent(forecast.metrics.openInterestChange)} | Funding: ${formatPercent(forecast.metrics.fundingRate)}`,
    `Liquidation pressure: ${forecast.metrics.liquidationPressure}/100`,
    "",
    "MTF details:",
    ...forecast.frames.map((frame) => `${frame.timeframe}: RSI ${frame.rsi}, EMA ${frame.emaStructure}, structure ${frame.marketStructure}, volatility ${frame.volatility}%`),
    "",
    "Причина:",
    ...forecast.reasons.slice(0, 7).map((reason) => `✔ ${reason}`),
    ...forecast.warnings.slice(0, 3).map((warning) => `⚠ ${warning}`),
    "",
    "Рекомендація:",
    ...forecast.recommendation,
    "",
    `Оновлено: ${shortTime(forecast.updatedAt)} | latency ${forecast.latencyMs}ms`
  ].join("\n");
}

export function formatBtcMarket(forecast: BtcForecast) {
  return [
    "📊 BTC Market",
    "",
    "Trend:",
    `${marketIcon(forecast.market.trend)} ${forecast.market.trend}`,
    "",
    "Volatility:",
    forecast.market.volatility,
    "",
    "Risk:",
    forecast.market.risk,
    "",
    "Scalp:",
    forecast.market.scalp,
    "",
    "Swing:",
    forecast.market.swing,
    "",
    "Altcoins:",
    forecast.market.altcoins,
    "",
    `Оновлено: ${shortTime(forecast.updatedAt)} | latency ${forecast.latencyMs}ms`
  ].join("\n");
}

function frameForecast(timeframe: TimeframeForecast["timeframe"], candles: Candle[], orderbookImbalance: number, fundingRate: number, openInterestChange: number) {
  const closes = candles.map((c) => c.close);
  const last = closes.at(-1) ?? 0;
  const ema21 = ema(closes, 21).at(-1) ?? last;
  const ema50 = ema(closes, 50).at(-1) ?? ema21;
  const rsiValue = rsi(closes);
  const macdValue = macd(closes).histogram;
  const volume = volumeProfileScore(candles);
  const structure = marketStructure(candles);
  const volatilityPct = last ? atr(candles) / last : 0;
  const trendScore = clamp(50 + (ema21 > ema50 ? 18 : -18) + (last > ema21 ? 12 : -12) + macdValue / Math.max(last, 1) * 9000 + (rsiValue - 50) * 0.65 + (volume - 50) * 0.2 + orderbookImbalance * 18 + openInterestChange * 600 - Math.abs(fundingRate) * 4500 + structure * 12 - volatilityPct * 220);
  const direction: Direction = trendScore >= 58 ? "Bullish" : trendScore <= 42 ? "Bearish" : "Neutral";
  const directionalProbability = direction === "Bearish" ? 100 - trendScore : direction === "Bullish" ? trendScore : Math.max(50, Math.min(58, trendScore));
  const bullishProbability = Math.round(clamp(trendScore, 5, 95));
  const bearishProbability = Math.round(clamp(100 - trendScore, 5, 95));
  const emaStructure: TimeframeForecast["emaStructure"] = ema21 > ema50 && last > ema21 ? "bullish" : ema21 < ema50 && last < ema21 ? "bearish" : "neutral";
  const structureLabel: TimeframeForecast["marketStructure"] = structure > 0 ? "HH/HL" : structure < 0 ? "LH/LL" : "range";
  return { timeframe, direction, probability: Math.round(clamp(directionalProbability, 5, 95)), trend: Math.round(Math.abs(trendScore - 50) * 2), bullishProbability, bearishProbability, strength: Math.round(Math.abs(trendScore - 50) * 2), rsiValue, volume, emaBullish: ema21 > ema50 && last > ema21, momentumBullish: macdValue > 0, orderbookImbalance, fundingRate, openInterestChange, structure, structureLabel, emaStructure, volatilityPct };
}

function marketStructure(candles: Candle[]) {
  const recent = candles.slice(-24);
  if (recent.length < 8) return 0;
  const firstHigh = Math.max(...recent.slice(0, Math.floor(recent.length / 2)).map((c) => c.high));
  const firstLow = Math.min(...recent.slice(0, Math.floor(recent.length / 2)).map((c) => c.low));
  const lastHigh = Math.max(...recent.slice(Math.floor(recent.length / 2)).map((c) => c.high));
  const lastLow = Math.min(...recent.slice(Math.floor(recent.length / 2)).map((c) => c.low));
  if (lastHigh > firstHigh && lastLow > firstLow) return 1;
  if (lastHigh < firstHigh && lastLow < firstLow) return -1;
  return 0;
}

function btcReasons(contexts: ReturnType<typeof frameForecast>[], orderbookImbalance: number, fundingRate: number, openInterestChange: number) {
  const reasons: string[] = [];
  if (contexts.filter((x) => x.emaBullish).length >= 2) reasons.push("EMA висхідні на ключових TF");
  if (contexts.filter((x) => x.momentumBullish).length >= 2) reasons.push("Momentum сильний");
  if (contexts.some((x) => x.volume >= 65)) reasons.push("Volume підтверджує рух");
  if (orderbookImbalance > 0.05) reasons.push("Buy pressure > sell pressure");
  if (openInterestChange > 0.004) reasons.push("Open interest росте разом з напрямом");
  if (Math.abs(fundingRate) < 0.0008) reasons.push("Funding не перегрітий");
  if (contexts.filter((x) => x.structure > 0).length >= 2) reasons.push("Market structure формує higher highs/higher lows");
  if (!reasons.length) reasons.push("BTC без чистого edge, потрібне підтвердження");
  return reasons;
}

function btcWarnings(contexts: ReturnType<typeof frameForecast>[], spreadPct: number, fundingRate: number, spoofRisk: boolean) {
  const warnings: string[] = [];
  if (contexts.some((x) => x.rsiValue >= 72)) warnings.push("Перекупленість RSI");
  if (contexts.some((x) => x.rsiValue <= 28)) warnings.push("Перепроданість RSI");
  if (Math.abs(fundingRate) >= 0.0012) warnings.push("Funding перегрітий, можливий squeeze");
  if (spreadPct > 0.001 || spoofRisk) warnings.push("Orderbook/liquidity pressure нестабільний");
  return warnings;
}

function btcMarketState(contexts: ReturnType<typeof frameForecast>[], h1: Candle[], trendStrength: number): BtcForecast["market"] {
  const bullish = contexts.filter((x) => x.direction === "Bullish").length;
  const bearish = contexts.filter((x) => x.direction === "Bearish").length;
  const trend = bullish >= 2 && trendStrength >= 55 ? "Strong Bull" : bearish >= 2 && trendStrength >= 55 ? "Weak" : "Sideways";
  const last = h1.at(-1)?.close ?? 0;
  const volatilityPct = last ? atr(h1) / last : 0;
  const volatility = volatilityPct > 0.018 ? "High" : volatilityPct > 0.008 ? "Medium" : "Low";
  const risk = trend === "Strong Bull" && volatility !== "High" ? "Safe" : trend === "Weak" || volatility === "High" ? "Aggressive" : "Medium";
  return {
    trend,
    volatility,
    risk,
    scalp: volatility === "High" || trend === "Weak" ? "Caution" : "Allowed",
    swing: trend === "Strong Bull" ? "Preferred" : trend === "Sideways" ? "Allowed" : "Avoid",
    altcoins: trend === "Strong Bull" ? "Higher probability of continuation." : trend === "Sideways" ? "Only strong alts; avoid weak chop." : "Alt continuation risk is high."
  };
}

function btcRecommendation(contexts: ReturnType<typeof frameForecast>[], market: BtcForecast["market"]) {
  if (market.trend === "Strong Bull") return ["Альти можуть показувати strength.", "LONG setup preferred.", "High risk shorts."];
  if (market.trend === "Weak") return ["Альти під тиском BTC.", "SHORT/hedge setup preferred.", "LONG тільки після чіткого reclaim."];
  const bias = contexts[0]?.direction === "Bullish" ? "локальні LONG тільки від підтримки" : contexts[0]?.direction === "Bearish" ? "локальні SHORT тільки від resistance" : "чекати breakout/retest";
  return ["Ринок змішаний.", bias, "Зменшити розмір позиції."];
}

async function fetchGlobalCryptoMarket() {
  const res = await fetch("https://api.coingecko.com/api/v3/global", { headers: { "user-agent": "tradering-bot/1.0" }, signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`CoinGecko global failed ${res.status}`);
  const body = await res.json() as { data?: { market_cap_percentage?: { btc?: number } } };
  const btcDominance = Number(body.data?.market_cap_percentage?.btc ?? 0);
  if (!Number.isFinite(btcDominance) || btcDominance <= 0) throw new Error("CoinGecko BTC dominance unavailable");
  return { btcDominance };
}

function contextsPerformance(h1: Candle[], h4: Candle[], d1: Candle[]) {
  return [performancePct(h1, 24), performancePct(h4, 18), performancePct(d1, 14)].reduce((sum, value) => sum + value, 0) / 3;
}

function performancePct(candles: Candle[], lookback: number) {
  const last = candles.at(-1)?.close ?? 0;
  const prev = candles.at(-lookback)?.close ?? candles[0]?.close ?? last;
  return prev ? (last - prev) / prev : 0;
}

function dominanceTrend(btcDominance: number | undefined, btcPerformance: number): BtcForecast["metrics"]["btcDominanceTrend"] {
  if (!btcDominance) return btcPerformance > 0.015 ? "rising" : btcPerformance < -0.015 ? "falling" : "flat";
  if (btcDominance >= 56 && btcPerformance >= 0) return "rising";
  if (btcDominance <= 52 || btcPerformance < -0.02) return "falling";
  return "flat";
}

function liquidationPressureScore(orderbookImbalance: number, fundingRate: number, openInterestChange: number, spoofRisk: boolean) {
  return Math.round(clamp(Math.abs(orderbookImbalance) * 45 + Math.abs(fundingRate) * 20000 + Math.abs(openInterestChange) * 1200 + (spoofRisk ? 20 : 0)));
}

function directionIcon(direction: Direction) {
  if (direction === "Bullish") return "🟢";
  if (direction === "Bearish") return "🔴";
  return "🟡";
}

function marketIcon(trend: BtcForecast["market"]["trend"]) {
  if (trend === "Strong Bull") return "🟢";
  if (trend === "Weak") return "🔴";
  return "🟡";
}

function formatPrice(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : 4 });
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(3)}%`;
}

function shortTime(value: string) {
  return new Date(value).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
