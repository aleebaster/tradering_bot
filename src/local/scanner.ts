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

  constructor(private broadcast: Broadcast) {}

  async start() {
    await this.notifier.started().catch((err) => {
      state.diagnostics.apiStatus.telegram = "error";
      logger.warn({ err }, "Telegram startup alert failed");
    });
    state.diagnostics.apiStatus.telegram = "configured";
    await this.validateSymbols();
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
    this.scanning = true;
    try {
      const btcCandles = await this.loadCandles("BTCUSDT", "futures");
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
      state.diagnostics.lastScanAt = new Date().toISOString();
      state.diagnostics.scannedSymbols = this.symbols.length;
      state.marketCondition = summarize(candidates);
      this.broadcast({ type: "state", state });
    } catch (err) {
      logger.error({ err }, "Scan failed");
    } finally {
      this.scanning = false;
    }
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
    state.diagnostics.apiStatus.okx = config.partialMode ? "partial public confirmation" : "connected";
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
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
