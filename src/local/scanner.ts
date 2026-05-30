import WebSocket from "ws";
import { config } from "./config";
import { ExchangeClient } from "./exchanges";
import { btcStable, buildSignal, regimeFrom } from "./scoring";
import { recordSignal, state } from "./state";
import type { Candle, MarketSnapshot, Signal } from "./types";
import { logger } from "./logger";
import { TelegramNotifier } from "./telegram";

type Broadcast = (payload: unknown) => void;

export class Scanner {
  private client = new ExchangeClient();
  private notifier = new TelegramNotifier();
  private timer: NodeJS.Timeout | null = null;
  private sent = new Set<string>();
  private binanceWs: WebSocket | null = null;
  private scanning = false;
  private symbols = config.symbols;
  private cursor = 0;
  private managementSent = new Set<string>();
  private bybitCooldownUntil = 0;
  private btcCache: { candles: Record<string, Candle[]>; expiresAt: number } | null = null;

  constructor(private broadcast: Broadcast) {}

  async start() {
    await this.notifier.started().catch((err) => {
      state.diagnostics.apiStatus.telegram = "error";
      logger.warn({ err }, "Telegram startup alert failed");
    });
    state.diagnostics.apiStatus.telegram = "configured";
    await this.validateSymbols();
    await this.validateOkxAuth();
    this.connectBinanceTicker();
    await this.scan();
    this.timer = setInterval(() => void this.scan(), config.SCAN_INTERVAL_SECONDS * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.binanceWs?.close();
  }

  private connectBinanceTicker() {
    const streams = config.symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/");
    this.binanceWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    this.binanceWs.on("open", () => { state.diagnostics.apiStatus.binance = "websocket connected"; });
    this.binanceWs.on("close", () => setTimeout(() => this.connectBinanceTicker(), 15000));
    this.binanceWs.on("error", () => { state.diagnostics.apiStatus.binance = "websocket error"; });
  }

  private async scan() {
    if (this.scanning) return;
    if (Date.now() < this.bybitCooldownUntil) {
      state.diagnostics.apiStatus.bybit = `rate limited; cooling down until ${new Date(this.bybitCooldownUntil).toLocaleTimeString()}`;
      state.marketCondition = "Bybit rate limit cooldown active; scanner will resume automatically";
      this.broadcast({ type: "state", state });
      return;
    }
    this.scanning = true;
    try {
      const btcCandles = await this.loadBtcCandles();
      const btcOk = btcStable(btcCandles);
      const candidates: Signal[] = [];
      const symbol = this.symbols[this.cursor % this.symbols.length];
      const mode = Math.floor(this.cursor / this.symbols.length) % 2 === 0 ? "futures" : "spot";
      this.cursor += 1;
      const candles = symbol === "BTCUSDT" && mode === "futures" ? btcCandles : await this.loadCandles(symbol, mode);
      const snapshot = await this.snapshot(symbol, mode, candles, btcOk);
      const signal = buildSignal(snapshot);
      logger.info({ symbol, mode, side: signal.side, score: signal.score, winProbability: signal.winProbability, rejectionReason: signal.rejectionReason, scoreBreakdown: signal.scoreBreakdown }, "scan decision");
      recordSignal(signal);
      candidates.push(signal);
      if (!this.sent.has(signalKey(signal)) && !["NO_TRADE", "WATCHLIST"].includes(signal.side)) {
        this.sent.add(signalKey(signal));
        await this.notifier.signal(signal).catch((err) => logger.warn({ err }, "Telegram signal failed"));
      }
      await this.monitorActiveTrades(btcOk);
      state.diagnostics.lastScanAt = new Date().toISOString();
      state.diagnostics.scannedSymbols = this.symbols.length;
      state.marketCondition = summarize(candidates);
      this.broadcast({ type: "state", state });
    } catch (err) {
      if (isRateLimit(err)) {
        this.bybitCooldownUntil = Date.now() + 5 * 60 * 1000;
        state.diagnostics.apiStatus.bybit = "rate limited; automatic cooldown active";
        state.marketCondition = "Bybit rate limit cooldown active; scanner will resume automatically";
        this.broadcast({ type: "state", state });
      }
      logger.error({ err }, "Scan failed");
    } finally {
      this.scanning = false;
    }
  }

  private async loadBtcCandles() {
    if (this.btcCache && Date.now() < this.btcCache.expiresAt) return this.btcCache.candles;
    const candles = await this.loadCandles("BTCUSDT", "futures");
    this.btcCache = { candles, expiresAt: Date.now() + 60 * 1000 };
    return candles;
  }

  private async validateSymbols() {
    try {
      const [linear, spot] = await Promise.all([this.client.bybitInstrumentSymbols("linear"), this.client.bybitInstrumentSymbols("spot")]);
      const valid = config.symbols.filter((s) => linear.has(s) && spot.has(s));
      const invalid = config.symbols.filter((s) => !linear.has(s) || !spot.has(s));
      this.symbols = valid.length ? valid : ["BTCUSDT"];
      state.diagnostics.validSymbols = this.symbols;
      state.diagnostics.invalidSymbols = invalid;
      state.diagnostics.apiStatus.bybit = "symbols validated";
      logger.info({ validSymbols: this.symbols, invalidSymbols: invalid }, "Bybit symbol validation completed");
    } catch (err) {
      this.symbols = config.symbols;
      state.diagnostics.validSymbols = this.symbols;
      state.diagnostics.invalidSymbols = [];
      state.diagnostics.apiStatus.bybit = "using prevalidated symbols";
      logger.warn({ err, validSymbols: this.symbols }, "Bybit symbol validation temporarily unavailable; using prevalidated symbol universe");
    }
  }

  private async validateOkxAuth() {
    if (config.partialMode) {
      state.diagnostics.apiStatus.okx = "partial public confirmation";
      return;
    }
    try {
      const auth = await this.client.okxAuthCheck();
      state.diagnostics.apiStatus.okx = "authenticated and connected";
      logger.info({ accountLevel: auth.accountLevel, permissions: auth.permissions }, "OKX authentication successful");
    } catch (err) {
      state.diagnostics.apiStatus.okx = "authentication failed";
      logger.error({ err }, "OKX authentication failed");
    }
  }

  private async loadCandles(symbol: string, mode: "spot" | "futures"): Promise<Record<string, Candle[]>> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const category = mode === "spot" ? "spot" : "linear";
    const entries: Array<readonly [string, Candle[]]> = [];
    for (const tf of tfs) {
      entries.push([tf, await this.client.bybitKlines(symbol, tf, category)] as const);
      await sleep(150);
    }
    state.diagnostics.apiStatus.bybit = "connected";
    return Object.fromEntries(entries);
  }

  private async snapshot(symbol: string, mode: "spot" | "futures", candles: Record<string, Candle[]>, btcOk: boolean): Promise<MarketSnapshot> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const [okxEntries, binanceEntries, imbalance, funding, oi] = await Promise.all([
      Promise.all(tfs.map(async (tf) => [tf, await this.client.okxKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.binanceKlines(symbol, tf).catch(() => [])] as const)),
      mode === "futures" ? this.client.orderBookImbalance(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.fundingRate(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.openInterestChange(symbol).catch(() => 0) : Promise.resolve(0)
    ]);
    if (config.partialMode) state.diagnostics.apiStatus.okx = "partial public confirmation";
    else if (state.diagnostics.apiStatus.okx !== "authentication failed") state.diagnostics.apiStatus.okx = "authenticated and connected; market confirmation active";
    state.diagnostics.apiStatus.binance = "connected";
    const primary = candles[mode === "futures" ? "15" : "240"] ?? [];
    const dollarVolume = primary.slice(-24).reduce((s, c) => s + c.volume * c.close, 0) / 24;
    const whaleScore = Math.min(100, Math.max(0, Math.abs(oi) * 2500 + Math.abs(imbalance) * 120));
    return {
      symbol,
      mode,
      candles,
      okxCandles: Object.fromEntries(okxEntries),
      binanceCandles: Object.fromEntries(binanceEntries),
      orderBookImbalance: imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore: Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11),
      whaleScore,
      btcStable: btcOk,
      regime: regimeFrom(candles)
    };
  }

  private async monitorActiveTrades(btcOk: boolean) {
    for (const signal of state.activeSignals) {
      const category = signal.mode === "spot" ? "spot" : "linear";
      const tf = signal.mode === "spot" ? "60" : "5";
      const candles = await this.client.bybitKlines(signal.symbol, tf, category, 3).catch(() => []);
      const current = candles.at(-1)?.close ?? signal.currentPrice;
      const action = tradeManagementAction(signal, current, btcOk);
      if (!action) continue;
      const key = `${signal.id}-${action.label}`;
      if (this.managementSent.has(key)) continue;
      this.managementSent.add(key);
      logger.info({ symbol: signal.symbol, action: action.label, currentPrice: current, reasons: action.reasons }, "trade management alert");
      await this.notifier.tradeManagementAlert(signal, action.label, current, action.reasons).catch((err) => logger.warn({ err }, "Telegram trade management alert failed"));
    }
  }
}

function tradeManagementAction(signal: Signal, current: number, btcOk: boolean) {
  const long = signal.side === "LONG" || signal.side === "BUY";
  const short = signal.side === "SHORT";
  if (!long && !short) return null;
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  const entered = signal.entryStatus === "ENTER_NOW" || (current >= entryLow && current <= entryHigh);
  if (!entered) return { label: "⏳ WAIT FOR ENTRY", reasons: [`Current price ${formatPrice(current)} is outside entry zone ${formatPrice(entryLow)}-${formatPrice(entryHigh)}`] };
  if ((long && current <= signal.stopLoss) || (short && current >= signal.stopLoss)) return { label: "🔴 EXIT TRADE NOW", reasons: ["Stop loss or invalidation level reached", "Capital preservation rule triggered"] };
  if (!btcOk && signal.symbol !== "BTCUSDT") return { label: "⚠️ TREND REVERSAL DETECTED", reasons: ["BTC instability detected", "Altcoin exposure risk increased"] };
  if ((long && current >= signal.takeProfit[2]) || (short && current <= signal.takeProfit[2])) return { label: "🔴 EXIT TRADE NOW", reasons: ["TP3 reached", "Full planned reward captured"] };
  if ((long && current >= signal.takeProfit[1]) || (short && current <= signal.takeProfit[1])) return { label: "🟠 TRAIL STOP ACTIVATED", reasons: ["TP2 reached", "Trail remaining position with ATR structure"] };
  if ((long && current >= signal.takeProfit[0]) || (short && current <= signal.takeProfit[0])) return { label: "🟠 TAKE PARTIAL PROFIT", reasons: ["TP1 reached", "Move stop loss to breakeven"] };
  return { label: "🟡 HOLD POSITION", reasons: ["Entry active", "No exit condition triggered"] };
}

function formatPrice(value: number) {
  return value >= 100 ? value.toFixed(2) : value.toFixed(5);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Access too frequent") || message.includes("403 Forbidden") || message.includes("429");
}

function signalKey(s: Signal) {
  return `${s.symbol}-${s.mode}-${s.side}-${new Date().toISOString().slice(0, 10)}`;
}

function summarize(signals: Signal[]) {
  const risk = signals.some((s) => s.marketRegime === "MANIPULATION_RISK");
  if (risk) return "⚠️ HIGH RISK MARKET — NO TRADE";
  const best = signals.sort((a, b) => b.score - a.score)[0];
  return best ? `${best.marketRegime} market. Strongest setup: ${best.symbol} ${best.side} ${best.score}/100` : "No qualified market data yet";
}
