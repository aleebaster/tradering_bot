import crypto from "node:crypto";
import type { Candle } from "./types";
import { config } from "./config";

const BYBIT = "https://api.bybit.com";
const OKX = "https://www.okx.com";
const BINANCE = "https://api.binance.com";
const KUCOIN = "https://api.kucoin.com";
const KUCOIN_FUTURES = "https://api-futures.kucoin.com";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { "user-agent": "tradering-bot/1.0", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      const detail = text ? `: ${text.slice(0, 300)}` : "";
      if (![403, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${res.status} ${res.statusText} ${url}${detail}`);
      lastError = new Error(`${res.status} ${res.statusText} ${url}${detail}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200 + attempt * 1800));
  }
  throw lastError;
}

export class ExchangeClient {
  async bybitInstrumentSymbols(category: "linear" | "spot"): Promise<Set<string>> {
    const body = await json<{ result: { list: Array<{ symbol: string; status: string }> } }>(`${BYBIT}/v5/market/instruments-info?category=${category}`);
    return new Set(body.result.list.filter((x) => x.status === "Trading").map((x) => x.symbol));
  }

  async bybitKlines(symbol: string, interval: string, category: "linear" | "spot" = "linear", limit = 220): Promise<Candle[]> {
    const u = `${BYBIT}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const body = await json<{ result: { list: string[][] } }>(u);
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
    if (!config.OKX_API_KEY || !config.OKX_API_SECRET || !config.OKX_PASSPHRASE) throw new Error("OKX credentials incomplete");
    const timestamp = new Date().toISOString();
    const prehash = `${timestamp}GET${path}`;
    const sign = crypto.createHmac("sha256", config.OKX_API_SECRET).update(prehash).digest("base64");
    return json<T>(`${OKX}${path}`, {
      headers: {
        "OK-ACCESS-KEY": config.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": config.OKX_PASSPHRASE,
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
}
