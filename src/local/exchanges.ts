import crypto from "node:crypto";
import WebSocket from "ws";
import type { Candle, BybitOrderResult, BybitPosition, BybitTradingStopResult } from "./types";
import { config } from "./config";
import { logger } from "./logger";

const BYBIT = process.env.BYBIT_REST_URL ?? "https://api.bybit.com";
const BYBIT_FALLBACK_HOSTS = [BYBIT, "https://api.bybitglobal.com", "https://api.bybit.nl", "https://api.bybit-tr.com", "https://api.bytick.com", "https://api.bybit.kz"];
const OKX = "https://www.okx.com";
const BINANCE = "https://api.binance.com";
const KUCOIN = "https://api.kucoin.com";
const KUCOIN_FUTURES = "https://api-futures.kucoin.com";


const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const hostNextAllowedAt = new Map<string, number>();
const bybitCandleFallbackCache = new Map<string, Candle[]>();

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const cacheKey = `${method}:${url}`;
  const cached = method === "GET" ? responseCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const requestUrl of bybitRequestUrls(url)) {
      try {
        await throttle(requestUrl);
        const res = await fetch(requestUrl, { ...init, headers: { "user-agent": "tradering-bot/1.0", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const value = (await res.json()) as T;
          if (method === "GET") responseCache.set(cacheKey, { expiresAt: Date.now() + cacheTtl(url), value });
          return value;
        }
        const text = await res.text();
        const detail = text ? `: ${text.slice(0, 300)}` : "";
        if (![403, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`${res.status} ${res.statusText} ${requestUrl}${detail}`);
        lastError = new Error(`${res.status} ${res.statusText} ${requestUrl}${detail}`);
        if (res.status !== 403) break;
      } catch (err) {
        lastError = err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, url)));
  }
  throw lastError;
}

function bybitRequestUrls(url: string) {
  if (!url.includes("/v5/market/")) return [url];
  const parsed = new URL(url);
  if (!parsed.hostname.includes("bybit") && !parsed.hostname.includes("bytick")) return [url];
  return [...new Set(BYBIT_FALLBACK_HOSTS)].map((host) => `${host}${parsed.pathname}${parsed.search}`);
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
  if (url.includes("/v5/market/kline")) {
    const interval = new URL(url).searchParams.get("interval");
    if (interval === "1") return 2_000;
    if (interval === "3") return 4_000;
    if (interval === "5") return 7_000;
    if (interval === "15") return 15_000;
    if (interval === "60") return 30_000;
    return 60_000;
  }
  if (url.includes("/v5/market/instruments-info")) return 15 * 60_000;
  if (url.includes("/v5/market/tickers")) return 3_000;
  if (url.includes("/v5/market/orderbook")) return 20_000;
  if (url.includes("/v5/market/funding")) return 5 * 60_000;
  if (url.includes("/v5/market/open-interest")) return 60_000;
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
  async bybitInstrumentsDetailed(category: "spot" | "linear" | "inverse"): Promise<Array<{ symbol: string; status: string; launchTime: number; baseCoin: string; quoteCoin: string; contractType: string }>> {
    const out: Array<{ symbol: string; status: string; launchTime: number; baseCoin: string; quoteCoin: string; contractType: string }> = [];
    let cursor = "";
    for (let page = 0; page < 12; page++) {
      const endpoint = `${BYBIT}/v5/market/instruments-info?category=${category}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await json<{ retCode?: number; retMsg?: string; result?: { nextPageCursor?: string; list?: Array<{ symbol?: string; status?: string; launchTime?: string; baseCoin?: string; quoteCoin?: string; contractType?: string }> } }>(endpoint);
      const list = safeArray<{ symbol?: string; status?: string; launchTime?: string; baseCoin?: string; quoteCoin?: string; contractType?: string }>(body.result?.list);
      if (body.retCode !== 0 || !list.length) throw bybitDataError("Bybit instruments malformed", { endpoint, parsedData: body, category });
      for (const row of list) {
        if (!row.symbol || !row.status) continue;
        out.push({ symbol: row.symbol, status: row.status, launchTime: Number(row.launchTime ?? 0), baseCoin: row.baseCoin ?? baseFromSymbol(row.symbol, row.quoteCoin ?? ""), quoteCoin: row.quoteCoin ?? "", contractType: row.contractType ?? "" });
      }
      cursor = body.result?.nextPageCursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  async bybitLinearInstrumentsDetailed(): Promise<Array<{ symbol: string; status: string; launchTime: number; quoteCoin: string; contractType: string }>> {
    const out: Array<{ symbol: string; status: string; launchTime: number; quoteCoin: string; contractType: string }> = [];
    let cursor = "";
    for (let page = 0; page < 8; page++) {
      const endpoint = `${BYBIT}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await json<{ retCode?: number; retMsg?: string; result?: { nextPageCursor?: string; list?: Array<{ symbol?: string; status?: string; launchTime?: string; quoteCoin?: string; contractType?: string }> } }>(endpoint);
      const list = safeArray<{ symbol?: string; status?: string; launchTime?: string; quoteCoin?: string; contractType?: string }>(body.result?.list);
      if (body.retCode !== 0 || !list.length) throw bybitDataError("Bybit linear instruments malformed", { endpoint, parsedData: body });
      for (const row of list) {
        if (!row.symbol || !row.status) continue;
        out.push({ symbol: row.symbol, status: row.status, launchTime: Number(row.launchTime ?? 0), quoteCoin: row.quoteCoin ?? "", contractType: row.contractType ?? "" });
      }
      cursor = body.result?.nextPageCursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  async bybitLinearTickers(): Promise<Array<{ symbol: string; lastPrice: number; bid1Price: number; ask1Price: number; turnover24h: number; volume24h: number; price24hPcnt: number }>> {
    return this.bybitTickers("linear");
  }

  async bybitTickers(category: "spot" | "linear" | "inverse"): Promise<Array<{ symbol: string; lastPrice: number; bid1Price: number; ask1Price: number; turnover24h: number; volume24h: number; price24hPcnt: number }>> {
    const endpoint = `${BYBIT}/v5/market/tickers?category=${category}`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: Array<{ symbol?: string; lastPrice?: string; bid1Price?: string; ask1Price?: string; turnover24h?: string; volume24h?: string; price24hPcnt?: string }> } }>(endpoint);
    const list = safeArray<{ symbol?: string; lastPrice?: string; bid1Price?: string; ask1Price?: string; turnover24h?: string; volume24h?: string; price24hPcnt?: string }>(body.result?.list);
    if (body.retCode !== 0 || !list.length) throw bybitDataError("Bybit tickers malformed", { endpoint, parsedData: body, category });
    return list
      .filter((row) => typeof row.symbol === "string")
      .map((row) => ({ symbol: row.symbol!, lastPrice: Number(row.lastPrice ?? 0), bid1Price: Number(row.bid1Price ?? 0), ask1Price: Number(row.ask1Price ?? 0), turnover24h: Number(row.turnover24h ?? 0), volume24h: Number(row.volume24h ?? 0), price24hPcnt: Number(row.price24hPcnt ?? 0) }));
  }

  async bybitInstrumentSymbols(category: "linear" | "spot"): Promise<Set<string>> {
    const endpoint = `${BYBIT}/v5/market/instruments-info?category=${category}`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: Array<{ symbol?: string; status?: string }> } }>(endpoint);
    const list = safeArray<{ symbol?: string; status?: string }>(body.result?.list);
    if (!list.length) throw bybitDataError("Bybit instruments malformed", { endpoint, parsedData: body, category });
    return new Set(list.filter((x) => x?.status === "Trading" && typeof x.symbol === "string").map((x) => x.symbol!));
  }

  async bybitKlines(symbol: string, interval: string, category: "linear" | "spot" = "linear", limit = 220): Promise<Candle[]> {
    const endpoint = `${BYBIT}/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const candles = await this.bybitKlinesRest(endpoint, symbol, interval, category, limit).catch(async (restError) => {
      logger.warn({ err: restError, symbol, timeframe: interval, category, endpoint }, "Bybit REST failed; trying WebSocket/cache fallback");
      const fallback = await this.bybitKlinesFallback(symbol, interval, category, limit).catch((fallbackError) => {
        logger.error({ err: fallbackError, symbol, timeframe: interval, category, endpoint }, "Bybit WebSocket/cache fallback failed");
        return [];
      });
      if (fallback.length) return fallback;
      throw restError;
    });
    bybitCandleFallbackCache.set(bybitCacheKey(symbol, interval, category), candles);
    return candles;
  }

  private async bybitKlinesRest(endpoint: string, symbol: string, interval: string, category: "linear" | "spot", limit: number): Promise<Candle[]> {
    const { value, raw } = await bybitJsonWithRaw<{ retCode?: number; retMsg?: string; result?: { list?: unknown } }>(endpoint, { symbol, timeframe: interval });
    const list = safeArray(value.result?.list);
    if (value.retCode !== 0 || !list.length) {
      logBybitRaw("Bybit kline response invalid", { endpoint, rawResponse: raw, parsedData: value, symbol, timeframe: interval, category });
      throw bybitDataError("Bybit kline malformed", { endpoint, parsedData: value, symbol, timeframe: interval, category, retCode: value.retCode, retMsg: value.retMsg });
    }
    const candles = list.map((row) => parseBybitCandle(row, symbol, interval)).filter((candle): candle is Candle => Boolean(candle)).reverse().slice(-limit);
    if (!candles.length) {
      logBybitRaw("Bybit kline rows malformed", { endpoint, rawResponse: raw, parsedData: value, symbol, timeframe: interval, category });
      throw bybitDataError("Bybit kline rows malformed", { endpoint, parsedData: value, symbol, timeframe: interval, category });
    }
    return candles;
  }

  private async bybitKlinesFallback(symbol: string, interval: string, category: "linear" | "spot", limit: number): Promise<Candle[]> {
    const cached = bybitCandleFallbackCache.get(bybitCacheKey(symbol, interval, category)) ?? [];
    const wsCandle = await bybitKlineWebSocket(symbol, interval, category).catch(() => undefined);
    const merged = [...cached, ...(wsCandle ? [wsCandle] : [])]
      .filter((candle, index, all) => all.findIndex((x) => x.openTime === candle.openTime) === index)
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-limit);
    if (!merged.length) throw new Error(`Bybit fallback has no candles for ${symbol} ${interval}`);
    logger.warn({ symbol, timeframe: interval, category, cachedCandles: cached.length, websocketCandles: wsCandle ? 1 : 0, returnedCandles: merged.length }, "Bybit fallback returned candles");
    return merged;
  }

  async okxKlines(symbol: string, interval: string, limit = 220): Promise<Candle[]> {
    const bar = interval === "D" ? "1D" : `${interval}m`;
    let lastError: unknown;
    for (const instId of okxSwapInstrumentCandidates(symbol)) {
      try {
        const body = await json<{ code?: string; msg?: string; data?: string[][] }>(`${OKX}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
        if (body.code && body.code !== "0") throw new Error(`OKX candles failed ${body.code}: ${body.msg ?? "unknown"}`);
        const rows = body.data ?? [];
        if (!rows.length) throw new Error(`OKX candles empty for ${instId}`);
        return rows.reverse().map((r) => ({ exchange: "okx", symbol, timeframe: interval, openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
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
    const endpoint = `${BYBIT}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { b?: unknown; a?: unknown } }>(endpoint);
    const bidRows = safeArray<unknown>(body.result?.b);
    const askRows = safeArray<unknown>(body.result?.a);
    if (body.retCode !== 0 || !bidRows.length || !askRows.length) throw bybitDataError("Bybit orderbook malformed", { endpoint, parsedData: body, symbol });
    const bids = bidRows.reduce<number>((s, row) => s + orderBookValue(row), 0);
    const asks = askRows.reduce<number>((s, row) => s + orderBookValue(row), 0);
    return bids + asks === 0 ? 0 : (bids - asks) / (bids + asks);
  }

  async bybitOrderBookStats(symbol: string, category: "linear" | "spot" | "inverse" = "linear"): Promise<{ spreadPct: number; depthUsdt: number; imbalance: number; spoofRisk: boolean }> {
    const endpoint = `${BYBIT}/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=50`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { b?: unknown; a?: unknown } }>(endpoint);
    const bidRows = safeArray<unknown>(body.result?.b);
    const askRows = safeArray<unknown>(body.result?.a);
    if (body.retCode !== 0 || !bidRows.length || !askRows.length) throw bybitDataError("Bybit orderbook malformed", { endpoint, parsedData: body, symbol });
    const bestBid = orderBookPrice(bidRows[0]);
    const bestAsk = orderBookPrice(askRows[0]);
    const bids = bidRows.reduce<number>((s, row) => s + orderBookValue(row), 0);
    const asks = askRows.reduce<number>((s, row) => s + orderBookValue(row), 0);
    const depthUsdt = bids + asks;
    const imbalance = depthUsdt === 0 ? 0 : (bids - asks) / depthUsdt;
    const largestBidShare = Math.max(...bidRows.map(orderBookValue)) / Math.max(bids, 1);
    const largestAskShare = Math.max(...askRows.map(orderBookValue)) / Math.max(asks, 1);
    return { spreadPct: bestBid > 0 && bestAsk > 0 ? (bestAsk - bestBid) / ((bestAsk + bestBid) / 2) : 1, depthUsdt, imbalance, spoofRisk: largestBidShare > 0.38 || largestAskShare > 0.38 || Math.abs(imbalance) > 0.72 };
  }

  async fundingRate(symbol: string): Promise<number> {
    const endpoint = `${BYBIT}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: Array<{ fundingRate?: string }> } }>(endpoint);
    const list = safeArray<{ fundingRate?: string }>(body.result?.list);
    if (body.retCode !== 0 || !list.length) throw bybitDataError("Bybit funding malformed", { endpoint, parsedData: body, symbol });
    return Number(list[0]?.fundingRate ?? 0);
  }

  async openInterestChange(symbol: string): Promise<number> {
    const endpoint = `${BYBIT}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=12`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: Array<{ openInterest?: string }> } }>(endpoint);
    const rows = safeArray<{ openInterest?: string }>(body.result?.list);
    if (body.retCode !== 0 || rows.length < 2) throw bybitDataError("Bybit open interest malformed", { endpoint, parsedData: body, symbol });
    const list = rows.map((x) => Number(x.openInterest)).filter((x) => Number.isFinite(x)).reverse();
    if (list.length < 2 || list[0] === 0) return 0;
    return (list.at(-1)! - list[0]) / list[0];
  }

  async bybitAccountRatio(symbol: string): Promise<number> {
    const endpoint = `${BYBIT}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=5min&limit=12`;
    const body = await json<{ retCode?: number; retMsg?: string; result?: { list?: Array<{ buyRatio?: string; sellRatio?: string }> } }>(endpoint);
    const rows = safeArray<{ buyRatio?: string; sellRatio?: string }>(body.result?.list);
    if (body.retCode !== 0 || !rows.length) throw bybitDataError("Bybit account ratio malformed", { endpoint, parsedData: body, symbol });
    const latest = rows[0];
    const buy = Number(latest?.buyRatio ?? 0);
    const sell = Number(latest?.sellRatio ?? 0);
    return buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
  }

  signBybit(payload: string) {
    return crypto.createHmac("sha256", config.BYBIT_API_SECRET ?? "").update(payload).digest("hex");
  }

  private async bybitPrivatePost<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!config.BYBIT_API_KEY || !config.BYBIT_API_SECRET) throw new Error("Bybit credentials incomplete");
    const timestamp = Date.now().toString();
    const payload = timestamp + config.BYBIT_API_KEY + "10000" + JSON.stringify(body);
    const sign = this.signBybit(payload);
    return json<T>(endpoint, {
      method: "POST",
      headers: {
        "X-BAPI-API-KEY": config.BYBIT_API_KEY,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "10000",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  private async bybitPrivateGet<T>(endpoint: string): Promise<T> {
    if (!config.BYBIT_API_KEY || !config.BYBIT_API_SECRET) throw new Error("Bybit credentials incomplete");
    const timestamp = Date.now().toString();
    const qsIdx = endpoint.indexOf("?");
    const queryString = qsIdx >= 0 ? endpoint.slice(qsIdx + 1) : "";
    const payload = timestamp + config.BYBIT_API_KEY + "10000" + queryString;
    const sign = this.signBybit(payload);
    return json<T>(endpoint, {
      headers: {
        "X-BAPI-API-KEY": config.BYBIT_API_KEY,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "10000"
      }
    });
  }

  async bybitWalletBalance(): Promise<{ totalWalletBalance: number; availableBalance: number } | null> {
    try {
      const body = await this.bybitPrivateGet<Record<string, unknown>>(`${BYBIT}/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT`);
      const retCode = body?.retCode as number | undefined;
      if (retCode && retCode !== 0) return null;
      const result = body?.result as Record<string, unknown> | undefined;
      const list = (result?.list as Array<Record<string, string>> | undefined) ?? [];
      if (!list.length) return null;
      return { totalWalletBalance: Number(list[0]?.totalWalletBalance ?? 0), availableBalance: Number(list[0]?.availableBalance ?? 0) };
    } catch (err) {
      logger.warn({ err }, "bybitWalletBalance exception");
      return null;
    }
  }

  async bybitPositions(): Promise<Array<{ symbol: string; size: string; side: string }>> {
    try {
      const body = await this.bybitPrivateGet<Record<string, unknown>>(`${BYBIT}/v5/position/list?category=linear&settleCoin=USDT`);
      const result = body?.result as Record<string, unknown> | undefined;
      const list = (result?.list as Array<Record<string, string>> | undefined) ?? [];
      return list.map((p) => ({ symbol: p.symbol ?? "", size: p.size ?? "0", side: p.side ?? "" }));
    } catch {
      return [];
    }
  }

  async bybitOpenOrders(): Promise<Array<{ symbol: string; orderId: string; price: string; qty: string; side: string }>> {
    try {
      const body = await this.bybitPrivateGet<Record<string, unknown>>(`${BYBIT}/v5/order/realtime?category=linear&settleCoin=USDT`);
      const result = body?.result as Record<string, unknown> | undefined;
      const list = (result?.list as Array<Record<string, string>> | undefined) ?? [];
      return list.map((o) => ({ symbol: o.symbol ?? "", orderId: o.orderId ?? "", price: o.price ?? "", qty: o.qty ?? "", side: o.side ?? "" }));
    } catch {
      return [];
    }
  }

  async bybitPlaceOrder(symbol: string, side: "Buy" | "Sell", qty: string, orderType: "Market" | "Limit" = "Market", price?: string): Promise<BybitOrderResult> {
    const body: Record<string, unknown> = {
      category: "linear",
      symbol,
      side,
      orderType,
      qty,
      timeInForce: "IOC",
      positionIdx: 0
    };
    if (orderType === "Limit" && price) body.price = price;
    return this.bybitPrivatePost<BybitOrderResult>(`${BYBIT}/v5/order/create`, body);
  }

  async bybitSetTradingStop(symbol: string, side: "Buy" | "Sell", stopLoss?: string, takeProfit?: string): Promise<BybitTradingStopResult> {
    const body: Record<string, unknown> = {
      category: "linear",
      symbol
    };
    if (side === "Buy") body.positionIdx = 0;
    else body.positionIdx = 0;
    if (stopLoss) body.stopLoss = stopLoss;
    if (takeProfit) body.takeProfit = takeProfit;
    return this.bybitPrivatePost<BybitTradingStopResult>(`${BYBIT}/v5/position/trading-stop`, body);
  }

  async bybitGetPosition(symbol: string): Promise<BybitPosition | null> {
    try {
      const body = await this.bybitPrivateGet<Record<string, unknown>>(`${BYBIT}/v5/position/list?category=linear&symbol=${symbol}&settleCoin=USDT`);
      const retCode = body?.retCode as number | undefined;
      if (retCode && retCode !== 0) return null;
      const result = body?.result as Record<string, unknown> | undefined;
      const list = (result?.list as Array<Record<string, string>> | undefined) ?? [];
      const pos = list.find((p) => p.size && Number(p.size) > 0);
      if (!pos) return null;
      return {
        symbol: pos.symbol ?? "",
        side: pos.side as "Buy" | "Sell",
        size: pos.size ?? "0",
        avgPrice: pos.avgPrice ?? "0",
        stopLoss: pos.stopLoss ?? "",
        takeProfit: pos.takeProfit ?? "",
        positionStatus: pos.positionStatus ?? "",
        leverage: pos.leverage ?? "",
        unrealisedPnl: pos.unrealisedPnl ?? ""
      };
    } catch {
      return null;
    }
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

}

function okxSwapInstrumentCandidates(symbol: string) {
  const base = symbol.replace(/USDT$/, "");
  const candidates = [`${base}-USDT-SWAP`];
  if (/^1000[A-Z0-9]+$/.test(base)) candidates.push(`${base.slice(4)}-USDT-SWAP`);
  return candidates;
}

async function bybitJsonWithRaw<T>(url: string, context: Record<string, unknown>): Promise<{ value: T; raw: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await throttle(url);
      const res = await fetch(url, { headers: { "user-agent": "tradering-bot/1.0" }, signal: AbortSignal.timeout(8000) });
      const raw = await res.text();
      let value: T;
      try {
        value = JSON.parse(raw) as T;
      } catch (error) {
        logBybitRaw("Bybit JSON parse failed", { endpoint: url, rawResponse: raw, parsedData: null, attempt: attempt + 1, ...context });
        throw error;
      }
      if (process.env.BYBIT_RAW_LOG === "1") logBybitRaw("Bybit raw response", { endpoint: url, rawResponse: raw, parsedData: value, attempt: attempt + 1, ...context });
      if (res.ok) return { value, raw };
      throw new Error(`${res.status} ${res.statusText} ${url}: ${raw.slice(0, 300)}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, url)));
    }
  }
  throw lastError;
}

function logBybitRaw(message: string, data: Record<string, unknown>) {
  logger.info(data, message);
}

function bybitDataError(message: string, data: Record<string, unknown>) {
  const error = new Error(`${message}: ${JSON.stringify(data).slice(0, 1200)}`);
  error.name = "BybitDataError";
  return error;
}

function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function parseBybitCandle(row: unknown, symbol: string, interval: string): Candle | undefined {
  const data = safeArray<string | number>(row);
  if (data.length < 6) return undefined;
  const candle = { exchange: "bybit" as const, symbol, timeframe: interval, openTime: Number(data[0]), open: Number(data[1]), high: Number(data[2]), low: Number(data[3]), close: Number(data[4]), volume: Number(data[5]) };
  return Object.values(candle).every((value) => typeof value !== "number" || Number.isFinite(value)) ? candle : undefined;
}

function orderBookValue(row: unknown) {
  const data = safeArray<string | number>(row);
  const price = Number(data[0]);
  const quantity = Number(data[1]);
  return Number.isFinite(price) && Number.isFinite(quantity) ? price * quantity : 0;
}

function orderBookPrice(row: unknown) {
  const data = safeArray<string | number>(row);
  const price = Number(data[0]);
  return Number.isFinite(price) ? price : 0;
}

function bybitCacheKey(symbol: string, interval: string, category: string) {
  return `${category}:${symbol}:${interval}`;
}

function baseFromSymbol(symbol: string, quote: string) {
  return quote && symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol;
}

function bybitKlineWebSocket(symbol: string, interval: string, category: "linear" | "spot") {
  return new Promise<Candle | undefined>((resolve, reject) => {
    const url = category === "spot" ? "wss://stream.bybit.com/v5/public/spot" : "wss://stream.bybit.com/v5/public/linear";
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Bybit WebSocket timeout ${symbol} ${interval}`));
    }, 12000);
    ws.on("open", () => ws.send(JSON.stringify({ op: "subscribe", args: [`kline.${interval}.${symbol}`] })));
    ws.on("message", (message) => {
      const raw = message.toString();
      let parsed: { data?: unknown };
      try {
        parsed = JSON.parse(raw) as { data?: unknown };
      } catch {
        return;
      }
      const row = safeArray(parsed.data)[0];
      const data = row && typeof row === "object" ? row as Record<string, unknown> : undefined;
      if (!data) return;
      const candle = {
        exchange: "bybit" as const,
        symbol,
        timeframe: interval,
        openTime: Number(data.start),
        open: Number(data.open),
        high: Number(data.high),
        low: Number(data.low),
        close: Number(data.close),
        volume: Number(data.volume)
      };
      if (!Object.values(candle).every((value) => typeof value !== "number" || Number.isFinite(value))) return;
      clearTimeout(timeout);
      ws.close();
      resolve(candle);
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
