import crypto from "node:crypto";
import type { Candle } from "./types";
import { config } from "./config";

const BYBIT = "https://api.bybit.com";
const OKX = "https://www.okx.com";
const BINANCE = "https://api.binance.com";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url}`);
  return (await res.json()) as T;
}

export class ExchangeClient {
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

  async binanceKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const map: Record<string, string> = { "5": "5m", "15": "15m", "60": "1h", "240": "4h", D: "1d" };
    const body = await json<Array<Array<string | number>>>(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${map[interval]}&limit=${limit}`);
    return body.map((r) => ({ exchange: "binance", symbol, timeframe: interval, openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
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
}
