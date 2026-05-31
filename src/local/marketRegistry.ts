import { ExchangeClient } from "./exchanges";

export type RegistryMarketType = "spot" | "linear" | "inverse";

export type MarketRegistryItem = {
  symbol: string;
  marketType: RegistryMarketType;
  baseAsset: string;
  quoteAsset: string;
  liquidity: number;
  volume24h: number;
  turnover24h: number;
  spreadPct: number;
  listingAgeDays: number | null;
  fundingRate?: number;
  tradable: boolean;
  lastPrice: number;
  price24hPcnt: number;
  contractType?: string;
};

export type PairSearchResult = {
  query: string;
  normalized: string;
  exact: boolean;
  futures: MarketRegistryItem[];
  spot: MarketRegistryItem[];
  best?: MarketRegistryItem;
  suggestions: MarketRegistryItem[];
};

const client = new ExchangeClient();
let cache: { expiresAt: number; updatedAt: string; items: MarketRegistryItem[] } | null = null;
let refreshPromise: Promise<MarketRegistryItem[]> | null = null;
const ttlMs = Number(process.env.MARKET_REGISTRY_TTL_MINUTES ?? 20) * 60_000;

export async function marketRegistry(force = false) {
  if (!force && cache && cache.expiresAt > Date.now()) return { updatedAt: cache.updatedAt, items: cache.items };
  if (!refreshPromise) refreshPromise = refreshRegistry().finally(() => { refreshPromise = null; });
  const items = await refreshPromise;
  return { updatedAt: cache?.updatedAt ?? new Date().toISOString(), items };
}

export async function resolvePair(query: string): Promise<PairSearchResult> {
  const normalized = normalizeQuery(query);
  const { items } = await marketRegistry();
  const scored = items.map((item) => ({ item, score: matchScore(item, normalized) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.item.turnover24h - a.item.turnover24h);
  const matches = scored.map((x) => x.item);
  const futures = matches.filter((x) => x.marketType !== "spot").slice(0, 8);
  const spot = matches.filter((x) => x.marketType === "spot").slice(0, 8);
  const best = futures[0] ?? spot[0] ?? matches[0];
  return { query, normalized, exact: Boolean(best && normalizeSymbol(best.symbol) === normalized), futures, spot, best, suggestions: matches.slice(0, 12) };
}

export function normalizeQuery(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/PERP$/, "");
}

export function marketHealth(item: MarketRegistryItem) {
  const volumeScore = Math.min(100, Math.log10(Math.max(item.turnover24h, 1)) * 9);
  const spreadScore = Math.max(0, 100 - item.spreadPct * 5000);
  const liquidityScore = Math.min(100, item.liquidity);
  const ageScore = item.listingAgeDays === null ? 50 : Math.min(100, item.listingAgeDays * 2);
  const score = Math.round(volumeScore * 0.35 + spreadScore * 0.25 + liquidityScore * 0.3 + ageScore * 0.1);
  return { score, label: score >= 75 ? "Strong" : score >= 55 ? "Tradable" : "Thin/Risky", volumeScore: Math.round(volumeScore), spreadScore: Math.round(spreadScore), liquidityScore: Math.round(liquidityScore) };
}

async function refreshRegistry() {
  const categories: RegistryMarketType[] = ["linear", "inverse", "spot"];
  const chunks = await Promise.all(categories.map(loadCategory));
  const items = chunks.flat().sort((a, b) => priority(b) - priority(a));
  cache = { updatedAt: new Date().toISOString(), expiresAt: Date.now() + ttlMs, items };
  return items;
}

async function loadCategory(category: RegistryMarketType) {
  const [instruments, tickers] = await Promise.all([client.bybitInstrumentsDetailed(category), client.bybitTickers(category)]);
  const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  return instruments.map((instrument) => {
    const ticker = tickerMap.get(instrument.symbol);
    const spreadPct = ticker && ticker.bid1Price > 0 && ticker.ask1Price > 0 ? (ticker.ask1Price - ticker.bid1Price) / ((ticker.ask1Price + ticker.bid1Price) / 2) : 1;
    return {
      symbol: instrument.symbol,
      marketType: category,
      baseAsset: instrument.baseCoin || baseFromSymbol(instrument.symbol, instrument.quoteCoin),
      quoteAsset: instrument.quoteCoin,
      liquidity: liquidityScore(ticker?.turnover24h ?? 0, spreadPct),
      volume24h: ticker?.volume24h ?? 0,
      turnover24h: ticker?.turnover24h ?? 0,
      spreadPct,
      listingAgeDays: listingAgeDays(instrument.launchTime),
      tradable: instrument.status === "Trading",
      lastPrice: ticker?.lastPrice ?? 0,
      price24hPcnt: ticker?.price24hPcnt ?? 0,
      contractType: instrument.contractType
    } satisfies MarketRegistryItem;
  });
}

function matchScore(item: MarketRegistryItem, normalized: string) {
  const symbol = normalizeSymbol(item.symbol);
  const base = normalizeSymbol(item.baseAsset);
  const quote = normalizeSymbol(item.quoteAsset);
  const withoutPerp = symbol.replace(/PERP$/, "");
  const noQuote = withoutPerp.endsWith(quote) ? withoutPerp.slice(0, -quote.length) : withoutPerp;
  const aliases = aliasCandidates(normalized);
  if (aliases.includes(symbol)) return 120;
  if (aliases.includes(base) || aliases.includes(noQuote)) return 110;
  if (symbol.startsWith(normalized) || base.startsWith(normalized) || noQuote.startsWith(normalized)) return 80;
  if (normalized.length >= 5 && (symbol.includes(normalized) || base.includes(normalized) || noQuote.includes(normalized))) return 55;
  return fuzzy(base, normalized) || fuzzy(noQuote, normalized) ? 35 : 0;
}

function aliasCandidates(value: string) {
  const out = new Set([value]);
  if (!value.endsWith("USDT")) out.add(`${value}USDT`);
  if (!value.startsWith("1000")) out.add(`1000${value}`);
  if (!value.startsWith("1000") && !value.endsWith("USDT")) out.add(`1000${value}USDT`);
  return [...out];
}

function normalizeSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function fuzzy(a: string, b: string) {
  if (b.length < 5) return false;
  if (a[0] !== b[0]) return false;
  if (Math.abs(a.length - b.length) > Math.max(3, b.length)) return false;
  let j = 0;
  for (const char of a) if (char === b[j]) j += 1;
  return j >= Math.min(b.length, 4);
}

function liquidityScore(turnover: number, spreadPct: number) {
  const volume = Math.min(100, Math.log10(Math.max(turnover, 1)) * 10);
  const spread = Math.max(0, 100 - spreadPct * 5000);
  return Math.round(volume * 0.65 + spread * 0.35);
}

function listingAgeDays(launchTime: number) {
  if (!launchTime) return null;
  return Math.max(0, Math.round((Date.now() - launchTime) / 86_400_000));
}

function baseFromSymbol(symbol: string, quote: string) {
  return quote && symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol;
}

function priority(item: MarketRegistryItem) {
  return (item.marketType === "linear" ? 20 : item.marketType === "spot" ? 10 : 0) + item.turnover24h / 1_000_000 + item.liquidity;
}
