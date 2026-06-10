import { ExchangeClient } from "./exchanges";
import { clamp } from "./indicators";

type SectorState = "🔥" | "🟡" | "🔴";

export type AltseasonIndex = {
  index: number;
  regime: "BTC season" | "mixed market" | "mini altseason" | "strong altseason";
  reasons: string[];
  warnings: string[];
  sectors: Array<{ name: string; state: SectorState; score: number }>;
  recommendation: string;
  metrics: {
    btcPerformance: number;
    topAltAverage: number;
    ethBtc: number;
    rotationScore: number;
    stablecoinProxy: number;
    btcDominance: number;
    btcDominanceTrend: "rising" | "flat" | "falling";
    total3Proxy: number;
    total3Trend: "rising" | "flat" | "falling";
    altMarketCapUsd: number;
    ethBtcRatio: number;
    topAltsOutperformPct: number;
    sectorMomentum: number;
  };
  updatedAt: string;
  latencyMs: number;
};

const CACHE_MS = 45_000;
let cache: { expiresAt: number; value: AltseasonIndex } | null = null;
const client = new ExchangeClient();

const TOP_ALT_SYMBOLS = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT", "TRXUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "UNIUSDT", "AAVEUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "INJUSDT", "SUIUSDT", "SEIUSDT", "TIAUSDT", "FETUSDT", "RENDERUSDT", "WIFUSDT", "PEPEUSDT", "SHIBUSDT", "FLOKIUSDT", "BONKUSDT"];

const SECTORS: Record<string, string[]> = {
  AI: ["FETUSDT", "RENDERUSDT", "TAOUSDT", "AIUSDT", "ARKMUSDT", "WLDUSDT"],
  Meme: ["DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "WIFUSDT", "FLOKIUSDT", "BONKUSDT"],
  Gaming: ["IMXUSDT", "GALAUSDT", "SANDUSDT", "MANAUSDT", "RONUSDT", "AXSUSDT"],
  DeFi: ["UNIUSDT", "AAVEUSDT", "MKRUSDT", "CRVUSDT", "LDOUSDT", "PENDLEUSDT"],
  RWA: ["ONDOUSDT", "LINKUSDT", "POLYXUSDT", "OMUSDT", "PENDLEUSDT"]
};

export async function getAltseasonIndex(): Promise<AltseasonIndex> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const startedAt = Date.now();
  const [linearTickers, spotTickers, globalMarket] = await Promise.all([
    client.bybitTickers("linear"),
    client.bybitTickers("spot").catch(() => []),
    fetchGlobalCryptoMarket().catch(() => null)
  ]);
  const tickers = mergeTickers(linearTickers, spotTickers);
  const btc = tickers.get("BTCUSDT")?.price24hPcnt ?? 0;
  const eth = tickers.get("ETHUSDT")?.price24hPcnt ?? 0;
  const btcPrice = tickers.get("BTCUSDT")?.lastPrice ?? 0;
  const ethPrice = tickers.get("ETHUSDT")?.lastPrice ?? 0;
  const topAltRows = TOP_ALT_SYMBOLS.map((symbol) => tickers.get(symbol)).filter((row): row is NonNullable<ReturnType<typeof tickers.get>> => Boolean(row));
  const topAltAverage = average(topAltRows.map((row) => row.price24hPcnt));
  const outperformCount = topAltRows.filter((row) => row.price24hPcnt > btc + 0.002).length;
  const rotationScore = topAltRows.length ? outperformCount / topAltRows.length * 100 : 50;
  const topAltsOutperformPct = Math.round(rotationScore);
  const ethBtc = clamp(50 + (eth - btc) * 900);
  const ethBtcRatio = btcPrice ? ethPrice / btcPrice : 0;
  const btcDominance = globalMarket?.btcDominance ?? clamp(50 - (topAltAverage - btc) * 700);
  const btcDominanceTrend = dominanceTrend(btcDominance, topAltAverage, btc);
  const btcDominanceScore = clamp(100 - btcDominance);
  const stablecoinProxy = stablecoinInflowProxy(tickers);
  const sectorRows = Object.entries(SECTORS).map(([name, symbols]) => sectorScore(name, symbols, tickers, btc));
  const sectorMomentum = average(sectorRows.map((sector) => sector.score));
  const total3Proxy = globalMarket?.total3Score ?? clamp(50 + (topAltAverage - btc) * 800 + sectorMomentum * 0.15 - 7.5);
  const total3Trend = total3TrendFrom(total3Proxy, topAltAverage, sectorMomentum);
  const raw = clamp(0.22 * btcDominanceScore + 0.18 * total3Proxy + 0.18 * ethBtc + 0.18 * rotationScore + 0.1 * stablecoinProxy + 0.14 * sectorMomentum);
  const index = Math.round(raw);
  const value: AltseasonIndex = {
    index,
    regime: regimeFrom(index),
    reasons: altseasonReasons({ btc, eth, topAltAverage, rotationScore, ethBtc, btcDominance, total3Proxy, stablecoinProxy, hasGlobalMarket: Boolean(globalMarket) }),
    warnings: altseasonWarnings({ btc, topAltAverage, stablecoinProxy, rotationScore }),
    sectors: sectorRows,
    recommendation: recommendationFrom(index),
    metrics: { btcPerformance: btc, topAltAverage, ethBtc, rotationScore, stablecoinProxy, btcDominance, btcDominanceTrend, total3Proxy, total3Trend, altMarketCapUsd: globalMarket?.altMarketCapUsd ?? 0, ethBtcRatio, topAltsOutperformPct, sectorMomentum: Math.round(sectorMomentum) },
    updatedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt
  };
  cache = { expiresAt: Date.now() + CACHE_MS, value };
  return value;
}

export function formatAltseasonIndex(index: AltseasonIndex) {
  return [
    "🌊 Altseason Index",
    "",
    "Поточний стан:",
    `${index.index}%`,
    "",
    "Режим:",
    `${regimeIcon(index.regime)} ${titleRegime(index.regime)}`,
    "",
    "Причина:",
    ...index.reasons.slice(0, 6).map((reason) => `✔ ${reason}`),
    ...index.warnings.slice(0, 3).map((warning) => `⚠ ${warning}`),
    "",
    "Метрики:",
    `BTC dominance: ${index.metrics.btcDominance.toFixed(2)}% (${index.metrics.btcDominanceTrend})`,
    `TOTAL3 trend: ${index.metrics.total3Trend} (${Math.round(index.metrics.total3Proxy)}%)`,
    `ETH/BTC: ${index.metrics.ethBtcRatio.toFixed(5)} | strength ${Math.round(index.metrics.ethBtc)}%`,
    `Top alts outperform BTC: ${index.metrics.topAltsOutperformPct}%`,
    `Sector momentum: ${index.metrics.sectorMomentum}%`,
    "",
    "Сектори:",
    ...index.sectors.map((sector) => `${sector.state} ${sector.name} ${sector.score}%`),
    "",
    "Рекомендація:",
    index.recommendation,
    "",
    `Оновлено: ${shortTime(index.updatedAt)} | latency ${index.latencyMs}ms`
  ].join("\n");
}

type Ticker = Awaited<ReturnType<ExchangeClient["bybitTickers"]>>[number];

function mergeTickers(linear: Ticker[], spot: Ticker[]) {
  const out = new Map<string, Ticker>();
  for (const row of [...spot, ...linear]) if (row.symbol.endsWith("USDT")) out.set(row.symbol, row);
  return out;
}

function stablecoinInflowProxy(tickers: Map<string, Ticker>) {
  const stableSymbols = ["USDCUSDT", "FDUSDUSDT", "USDEUSDT"];
  const turnover = stableSymbols.reduce((sum, symbol) => sum + (tickers.get(symbol)?.turnover24h ?? 0), 0);
  const btcTurnover = tickers.get("BTCUSDT")?.turnover24h ?? 1;
  return clamp(45 + Math.log10(Math.max(turnover / Math.max(btcTurnover, 1), 0.001) + 1) * 30);
}

function sectorScore(name: string, symbols: string[], tickers: Map<string, Ticker>, btcPerformance: number) {
  const rows = symbols.map((symbol) => tickers.get(symbol)).filter((row): row is Ticker => Boolean(row));
  const avg = average(rows.map((row) => row.price24hPcnt));
  const score = clamp(50 + (avg - btcPerformance) * 900 + rows.filter((row) => row.price24hPcnt > btcPerformance).length * 5);
  const state: SectorState = score >= 62 ? "🔥" : score >= 45 ? "🟡" : "🔴";
  return { name, state, score: Math.round(score) };
}

function dominanceTrend(btcDominance: number, topAltAverage: number, btcPerformance: number): AltseasonIndex["metrics"]["btcDominanceTrend"] {
  const altSpread = topAltAverage - btcPerformance;
  if (btcDominance >= 56 && altSpread < 0) return "rising";
  if (btcDominance <= 52 || altSpread > 0.008) return "falling";
  return "flat";
}

function total3TrendFrom(total3Proxy: number, topAltAverage: number, sectorMomentum: number): AltseasonIndex["metrics"]["total3Trend"] {
  if (total3Proxy >= 58 || topAltAverage > 0.01 || sectorMomentum >= 58) return "rising";
  if (total3Proxy <= 42 || topAltAverage < -0.015 || sectorMomentum <= 42) return "falling";
  return "flat";
}

async function fetchGlobalCryptoMarket() {
  const res = await fetch("https://api.coingecko.com/api/v3/global", { headers: { "user-agent": "tradering-bot/1.0" }, signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`CoinGecko global failed ${res.status}`);
  const body = await res.json() as { data?: { market_cap_percentage?: { btc?: number; eth?: number }; total_market_cap?: { usd?: number } } };
  const total = Number(body.data?.total_market_cap?.usd ?? 0);
  const btcDominance = Number(body.data?.market_cap_percentage?.btc ?? 0);
  const ethDominance = Number(body.data?.market_cap_percentage?.eth ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(btcDominance) || btcDominance <= 0) throw new Error("CoinGecko global data incomplete");
  const altMarketCapUsd = total * Math.max(0, 100 - btcDominance) / 100;
  const total3Share = Math.max(0, 100 - btcDominance - ethDominance);
  return { btcDominance, altMarketCapUsd, total3Score: clamp(total3Share * 2.2) };
}

function altseasonReasons(metrics: { btc: number; eth: number; topAltAverage: number; rotationScore: number; ethBtc: number; btcDominance: number; total3Proxy: number; stablecoinProxy: number; hasGlobalMarket: boolean }) {
  const reasons: string[] = [];
  if (metrics.btcDominance < 52) reasons.push(metrics.hasGlobalMarket ? "BTC dominance слабшає" : "BTC dominance proxy слабшає");
  if (metrics.eth > metrics.btc) reasons.push("ETH stronger than BTC");
  if (metrics.total3Proxy >= 58) reasons.push("TOTAL3 proxy росте");
  if (metrics.rotationScore >= 58) reasons.push("Top altcoins outperform BTC");
  if (metrics.stablecoinProxy >= 55) reasons.push("Stablecoin liquidity proxy підтримує risk-on");
  if (metrics.topAltAverage > 0) reasons.push("Alt market cap proxy позитивний");
  if (!reasons.length) reasons.push("Ротація в альти слабка або змішана");
  return reasons;
}

function altseasonWarnings(metrics: { btc: number; topAltAverage: number; stablecoinProxy: number; rotationScore: number }) {
  const warnings: string[] = [];
  if (metrics.btc < -0.025) warnings.push("BTC падає різко: альти можуть отримати sell pressure");
  if (metrics.topAltAverage < metrics.btc && metrics.rotationScore < 45) warnings.push("Топ альти слабші за BTC");
  if (metrics.stablecoinProxy < 42) warnings.push("Liquidity proxy слабкий");
  return warnings;
}

function regimeFrom(index: number): AltseasonIndex["regime"] {
  if (index >= 80) return "strong altseason";
  if (index >= 60) return "mini altseason";
  if (index >= 30) return "mixed market";
  return "BTC season";
}

function recommendationFrom(index: number) {
  if (index >= 80) return "Фокус на strong alts, але брати тільки clean retest/volume confirmation.";
  if (index >= 60) return "Фокус на strong alts.";
  if (index >= 30) return "Вибірково: тільки альти сильніші за BTC, без FOMO.";
  return "BTC season: альти обережно, пріоритет BTC/ETH або чекати rotation.";
}

function regimeIcon(regime: AltseasonIndex["regime"]) {
  if (regime === "strong altseason" || regime === "mini altseason") return "🟢";
  if (regime === "mixed market") return "🟡";
  return "🔴";
}

function titleRegime(regime: AltseasonIndex["regime"]) {
  if (regime === "strong altseason") return "Strong Altseason";
  if (regime === "mini altseason") return "Mini Altseason";
  if (regime === "mixed market") return "Mixed Market";
  return "BTC Season";
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function shortTime(value: string) {
  return new Date(value).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
