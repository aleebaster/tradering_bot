import crypto from "node:crypto";
import type { Candle } from "./types";
import { config } from "./config";

const BYBIT = "https://api.bybit.com";
const OKX = "https://www.okx.com";
const BINANCE = "https://api.binance.com";
const KUCOIN = "https://api.kucoin.com";
const KUCOIN_FUTURES = "https://api-futures.kucoin.com";
const KRAKEN = "https://api.kraken.com";
const KRAKEN_FUTURES = "https://futures.kraken.com";

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const hostNextAllowedAt = new Map<string, number>();

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const cacheKey = `${method}:${url}`;
  const cached = method === "GET" ? responseCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await throttle(url);
      const res = await fetch(url, { ...init, headers: { "user-agent": "tradering-bot/1.0", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const value = (await res.json()) as T;
        if (method === "GET") responseCache.set(cacheKey, { expiresAt: Date.now() + cacheTtl(url), value });
        return value;
      }
      const text = await res.text();
      const detail = text ? `: ${text.slice(0, 300)}` : "";
      if (![403, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${res.status} ${res.statusText} ${url}${detail}`);
      lastError = new Error(`${res.status} ${res.statusText} ${url}${detail}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, url)));
  }
  throw lastError;
}

async function throttle(url: string) {
  const host = new URL(url).host;
  const now = Date.now();
  const waitMs = Math.max(0, (hostNextAllowedAt.get(host) ?? 0) - now);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const minGap = host.includes("bybit") ? 900 : host.includes("binance") ? 450 : 300;
  hostNextAllowedAt.set(host, Date.now() + minGap);
}

function cacheTtl(url: string) {
  if (url.includes("api.bybit.com/v5/market/kline")) return 90_000;
  if (url.includes("api.bybit.com/v5/market/orderbook")) return 20_000;
  if (url.includes("api.bybit.com/v5/market/funding")) return 5 * 60_000;
  if (url.includes("api.bybit.com/v5/market/open-interest")) return 60_000;
  if (url.includes("api.binance.com")) return 45_000;
  if (url.includes("api.kucoin.com/api/v1/market/candles")) return 60_000;
  if (url.includes("www.okx.com/api/v5/market/candles")) return 60_000;
  return 10_000;
}

function backoffDelay(attempt: number, url: string) {
  const base = url.includes("bybit") ? 5_000 : 1_200;
  return base * 2 ** attempt;
}

export class ExchangeClient {
  async bybitInstrumentSymbols(category: "linear" | "spot"): Promise<Set<string>> {
    const body = await json<{ result: { list: Array<{ symbol: string; status: string }> } }>(`${BYBIT}/v5/market/instruments-info?category=${category}`);
    return new Set(body.result.list.filter((x) => x.status === "Trading").map((x) => x.symbol));
  }

  async bybitKlines(symbol: string, interval: string, category: "linear" | "spot" = "linear", limit = 220): Promise<Candle[]> {
    const u = `${BYBIT}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: string[][] } }>(u);
    if (!body.result?.list) throw new Error(`Bybit kline failed ${body.retCode ?? "unknown"}: ${body.retMsg ?? "missing result list"}`);
    return body.result.list.reverse().map((r) => ({ exchange: "bybit", symbol, timeframe: interval, openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  }

  async okxKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const instId = symbol.replace("USDT", "-USDT-SWAP");
    const bar = interval === "D" ? "1D" : `${interval}m`;
    const body = await json<{ data: string[][] }>(`${OKX}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
    return body.data.reverse().map((r) => ({ exchange: "okx", symbol, timeframe: interval, openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  }

  async okxAuthCheck(): Promise<{ ok: boolean; accountLevel?: string; permissions?: string }> {
    const path = "/api/v5/account/config";
    const body = await this.okxPrivateGet<{ code: string; msg: string; data: Array<{ acctLv?: string; perm?: string }> }>(path);
    if (body.code !== "0") throw new Error(`OKX auth failed ${body.code}: ${body.msg}`);
    return { ok: true, accountLevel: body.data[0]?.acctLv, permissions: body.data[0]?.perm };
  }

  async binanceKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const map: Record<string, string> = { "5": "5m", "15": "15m", "60": "1h", "240": "4h", D: "1d" };
    const body = await json<Array<Array<string | number>>>(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${map[interval]}&limit=${limit}`);
    return body.map((r) => ({ exchange: "binance", symbol, timeframe: interval, openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  }

  async kucoinKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const typeMap: Record<string, string> = { "5": "5min", "15": "15min", "60": "1hour", "240": "4hour", D: "1day" };
    const endAt = Math.floor(Date.now() / 1000);
    const seconds = interval === "D" ? 86400 : Number(interval) * 60;
    const startAt = endAt - seconds * limit;
    const kucoinSymbol = symbol.replace("USDT", "-USDT");
    const body = await json<{ code: string; data: string[][] }>(`${KUCOIN}/api/v1/market/candles?type=${typeMap[interval]}&symbol=${kucoinSymbol}&startAt=${startAt}&endAt=${endAt}`);
    if (body.code !== "200000") throw new Error(`KuCoin market candles failed: ${body.code}`);
    return body.data.reverse().slice(-limit).map((r) => ({ exchange: "kucoin" as Candle["exchange"], symbol, timeframe: interval, openTime: Number(r[0]) * 1000, open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), volume: Number(r[5]) }));
  }

  async kucoinFuturesTicker(symbol: string): Promise<{ ok: boolean; price?: number }> {
    const base = symbol.replace("USDT", "");
    const futuresSymbol = `${base === "BTC" ? "XBT" : base}USDTM`;
    const body = await json<{ code: string; data: { price?: string; markPrice?: string } }>(`${KUCOIN_FUTURES}/api/v1/ticker?symbol=${futuresSymbol}`);
    if (body.code !== "200000") throw new Error(`KuCoin futures ticker failed: ${body.code}`);
    return { ok: true, price: Number(body.data.price ?? body.data.markPrice ?? 0) };
  }

  async kucoinAuthCheck(): Promise<{ ok: boolean; uid?: string }> {
    const path = "/api/v1/accounts";
    const body = await this.kucoinPrivateGet<{ code: string; data: Array<{ id: string }> }>(path);
    if (body.code !== "200000") throw new Error(`KuCoin auth failed: ${body.code}`);
    return { ok: true, uid: body.data[0]?.id };
  }

  async kucoinPublicBullet() {
    return json<{ code: string; data: { token: string; instanceServers: Array<{ endpoint: string; pingInterval: number }> } }>(`${KUCOIN}/api/v1/bullet-public`, { method: "POST" });
  }

  async kucoinPrivateBullet() {
    return this.kucoinPrivatePost<{ code: string; data: { token: string; instanceServers: Array<{ endpoint: string; pingInterval: number }> } }>("/api/v1/bullet-private");
  }

  async krakenSpotKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const pair = krakenSpotPair(symbol);
    const minutes = interval === "D" ? 1440 : Number(interval);
    const body = await json<{ error: string[]; result: Record<string, Array<[number, string, string, string, string, string, string, number]>> }>(`${KRAKEN}/0/public/OHLC?pair=${pair}&interval=${minutes}`);
    if (body.error.length) throw new Error(`Kraken spot OHLC failed: ${body.error.join(",")}`);
    const key = Object.keys(body.result).find((x) => x !== "last")!;
    return body.result[key].slice(-limit).map((r) => ({ exchange: "kraken", symbol, timeframe: interval, openTime: r[0] * 1000, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[6]) }));
  }

  async krakenSpotAuthCheck(): Promise<{ ok: boolean; balances: number }> {
    const body = await this.krakenSpotPrivate<{ error: string[]; result: Record<string, string> }>("/0/private/Balance", {});
    if (body.error.length) throw new Error(`Kraken spot auth failed: ${body.error.join(",")}`);
    return { ok: true, balances: Object.keys(body.result).length };
  }

  async krakenFuturesAuthCheck(): Promise<{ ok: boolean; result?: string }> {
    const body = await this.krakenFuturesPrivate<{ result: string; error?: string }>("/api/v3/accounts", "");
    if (body.result !== "success") throw new Error(`Kraken futures auth failed: ${body.error ?? body.result}`);
    return { ok: true, result: body.result };
  }

  async krakenFuturesTicker(symbol: string): Promise<{ ok: boolean; price?: number }> {
    const futuresSymbol = krakenFuturesSymbol(symbol);
    const body = await json<{ result: string; tickers: Array<{ symbol: string; markPrice?: number; bid?: number; ask?: number }> }>(`${KRAKEN_FUTURES}/derivatives/api/v3/tickers`);
    if (body.result !== "success") throw new Error(`Kraken futures tickers failed: ${body.result}`);
    const ticker = body.tickers.find((x) => x.symbol === futuresSymbol);
    if (!ticker) throw new Error(`Kraken futures symbol not found: ${futuresSymbol}`);
    return { ok: true, price: Number(ticker.markPrice ?? ticker.bid ?? ticker.ask ?? 0) };
  }

  async orderBookImbalance(symbol: string): Promise<number> {
    const body = await json<{ result: { b: string[][]; a: string[][] } }>(`${BYBIT}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`);
    const bids = body.result.b.reduce((s, [p, q]) => s + Number(p) * Number(q), 0);
    const asks = body.result.a.reduce((s, [p, q]) => s + Number(p) * Number(q), 0);
    return bids + asks === 0 ? 0 : (bids - asks) / (bids + asks);
  }

  async fundingRate(symbol: string): Promise<number> {
    const body = await json<{ result: { list: Array<{ fundingRate: string }> } }>(`${BYBIT}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`);
    return Number(body.result.list[0]?.fundingRate ?? 0);
  }

  async openInterestChange(symbol: string): Promise<number> {
    const body = await json<{ result: { list: Array<{ openInterest: string }> } }>(`${BYBIT}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=12`);
    const list = body.result.list.map((x) => Number(x.openInterest)).reverse();
    if (list.length < 2 || list[0] === 0) return 0;
    return (list.at(-1)! - list[0]) / list[0];
  }

  signBybit(payload: string) {
    return crypto.createHmac("sha256", config.BYBIT_API_SECRET ?? "").update(payload).digest("hex");
  }

  private async okxPrivateGet<T>(path: string): Promise<T> {
    if (!config.OKX_API_KEY || !config.OKX_API_SECRET || !config.OKX_API_PASSPHRASE) throw new Error("OKX credentials incomplete");
    const timestamp = new Date().toISOString();
    const prehash = `${timestamp}GET${path}`;
    const sign = crypto.createHmac("sha256", config.OKX_API_SECRET).update(prehash).digest("base64");
    return json<T>(`${OKX}${path}`, {
      headers: {
        "OK-ACCESS-KEY": config.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": config.OKX_API_PASSPHRASE,
        "x-simulated-trading": "0"
      }
    });
  }

  private kucoinHeaders(method: "GET" | "POST", path: string, body = "") {
    if (!config.KUCOIN_API_KEY || !config.KUCOIN_API_SECRET || !config.KUCOIN_API_PASSPHRASE) throw new Error("KuCoin credentials incomplete");
    const timestamp = Date.now().toString();
    const sign = crypto.createHmac("sha256", config.KUCOIN_API_SECRET).update(`${timestamp}${method}${path}${body}`).digest("base64");
    const passphrase = crypto.createHmac("sha256", config.KUCOIN_API_SECRET).update(config.KUCOIN_API_PASSPHRASE).digest("base64");
    return {
      "KC-API-KEY": config.KUCOIN_API_KEY,
      "KC-API-SIGN": sign,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": "2",
      "content-type": "application/json"
    };
  }

  private async kucoinPrivateGet<T>(path: string): Promise<T> {
    return json<T>(`${KUCOIN}${path}`, { headers: this.kucoinHeaders("GET", path) });
  }

  private async kucoinPrivatePost<T>(path: string): Promise<T> {
    return json<T>(`${KUCOIN}${path}`, { method: "POST", headers: this.kucoinHeaders("POST", path) });
  }

  private async krakenSpotPrivate<T>(path: string, data: Record<string, string>): Promise<T> {
    if (!config.KRAKEN_SPOT_API_KEY || !config.KRAKEN_SPOT_API_SECRET) throw new Error("Kraken spot credentials incomplete");
    const nonce = Date.now().toString();
    const params = new URLSearchParams({ nonce, ...data });
    const sha = crypto.createHash("sha256").update(nonce + params.toString()).digest();
    const hmac = crypto.createHmac("sha512", Buffer.from(config.KRAKEN_SPOT_API_SECRET, "base64")).update(Buffer.concat([Buffer.from(path), sha])).digest("base64");
    return json<T>(`${KRAKEN}${path}`, { method: "POST", headers: { "API-Key": config.KRAKEN_SPOT_API_KEY, "API-Sign": hmac, "content-type": "application/x-www-form-urlencoded" }, body: params.toString() });
  }

  private async krakenFuturesPrivate<T>(path: string, postData: string): Promise<T> {
    if (!config.KRAKEN_FUTURES_API_KEY || !config.KRAKEN_FUTURES_API_SECRET) throw new Error("Kraken futures credentials incomplete");
    const nonce = Date.now().toString();
    const hash = crypto.createHash("sha256").update(postData + nonce + path).digest();
    const authent = crypto.createHmac("sha512", Buffer.from(config.KRAKEN_FUTURES_API_SECRET, "base64")).update(hash).digest("base64");
    return json<T>(`${KRAKEN_FUTURES}/derivatives${path}`, { headers: { APIKey: config.KRAKEN_FUTURES_API_KEY, Nonce: nonce, Authent: authent } });
  }
}

function krakenSpotPair(symbol: string) {
  const base = symbol.replace("USDT", "");
  return `${base === "BTC" ? "XBT" : base}USDT`;
}

function krakenFuturesSymbol(symbol: string) {
  const base = symbol.replace("USDT", "");
  return `PF_${base === "BTC" ? "XBT" : base}USD`;
}
