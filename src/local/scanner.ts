import WebSocket from "ws";
import { config } from "./config";
import { ExchangeClient } from "./exchanges";
import { btcStable, buildSignal, regimeFrom } from "./scoring";
import { recordSignal, state } from "./state";
import type { Candle, MarketSnapshot, Signal } from "./types";
import { logger } from "./logger";
import { isRealEntrySignal, TelegramNotifier } from "./telegram";
import { recordLearningOutcome } from "./learning";
import { loadPriorityWatchlist } from "./watchlistStore";
import { recordPaperClose, recordPaperOpen, recordPaperSetup, updatePaperTradeMemory } from "./paperTrading";
import { notificationsEnabled } from "./telegramSettings";
import { recordTradeMemory } from "./tradeMemory";
import { recordProtectionOutcome, signalsPaused } from "./lossProtection";

type Broadcast = (payload: unknown) => void;

export class Scanner {
  private client = new ExchangeClient();
  private notifier = new TelegramNotifier();
  private timer: NodeJS.Timeout | null = null;
  private watchlistTimer: NodeJS.Timeout | null = null;
  private signalCooldown = new Map<string, { score: number; sentAt: number }>();
  private watchlistSent = new Set<string>();
  private activatedWatchlist = new Set<string>();
  private invalidatedWatchlist = new Set<string>();
  private fomoWatchlist = new Set<string>();
  private watchlistCheckedAt = new Map<string, number>();
  private binanceWs: WebSocket | null = null;
  private scanning = false;
  private symbols = config.symbols;
  private cursor = 0;
  private managementSent = new Set<string>();
  private bybitCooldownUntil = 0;
  private btcCache: { candles: Record<string, Candle[]>; expiresAt: number } | null = null;
  private linearSymbols = new Set<string>();
  private spotSymbols = new Set<string>();

  constructor(private broadcast: Broadcast) {}

  async start() {
    await this.notifier.started().catch((err) => {
      state.diagnostics.apiStatus.telegram = "помилка";
      logger.warn({ err }, "Не вдалося надіслати стартове повідомлення Telegram");
    });
    state.diagnostics.apiStatus.telegram = "налаштовано";
    await this.validateOkxAuth();
    await this.validateKucoinAuth();
    await this.validateKrakenAuth();
    await this.validateSymbols();
    this.connectBinanceTicker();
    this.connectKucoinTicker();
    this.connectKrakenTicker();
    await this.scan();
    this.timer = setInterval(() => void this.scan(), config.SCAN_INTERVAL_SECONDS * 1000);
    this.watchlistTimer = setInterval(() => void this.monitorWatchlist(), 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watchlistTimer) clearInterval(this.watchlistTimer);
    this.binanceWs?.close();
  }

  private connectBinanceTicker() {
    const streams = config.symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/");
    this.binanceWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    this.binanceWs.on("open", () => { state.diagnostics.apiStatus.binance = "WebSocket підключено"; });
    this.binanceWs.on("close", () => setTimeout(() => this.connectBinanceTicker(), 15000));
    this.binanceWs.on("error", () => { state.diagnostics.apiStatus.binance = "помилка WebSocket"; });
  }

  private async connectKucoinTicker() {
    try {
      state.diagnostics.apiStatus.kucoin = "підключення WebSocket";
      const bullet = await this.client.kucoinPublicBullet();
      const server = bullet.data.instanceServers[0];
      const ws = new WebSocket(`${server.endpoint}?token=${bullet.data.token}&connectId=opencode-${Date.now()}`);
      ws.on("open", () => {
        state.diagnostics.apiStatus.kucoin = "WebSocket підключено";
        ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: "/market/ticker:BTC-USDT", privateChannel: false, response: true }));
      });
      ws.on("close", () => { state.diagnostics.apiStatus.kucoin = "перепідключення KuCoin"; setTimeout(() => void this.connectKucoinTicker(), 15000); });
      ws.on("error", () => { state.diagnostics.apiStatus.kucoin = "помилка WebSocket KuCoin"; });
    } catch (err) {
      state.diagnostics.apiStatus.kucoin = "помилка WebSocket KuCoin";
      logger.warn({ err }, "Помилка підключення KuCoin WebSocket");
    }
  }

  private connectKrakenTicker() {
    try {
      state.diagnostics.apiStatus.krakenSpot = "підключення WebSocket";
      const ws = new WebSocket("wss://ws.kraken.com/v2");
      ws.on("open", () => {
        state.diagnostics.apiStatus.krakenSpot = "WebSocket підключено";
        ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USDT"] } }));
      });
      ws.on("close", () => { state.diagnostics.apiStatus.krakenSpot = "перепідключення Kraken"; setTimeout(() => this.connectKrakenTicker(), 15000); });
      ws.on("error", () => { state.diagnostics.apiStatus.krakenSpot = "помилка WebSocket Kraken"; });
    } catch (err) {
      state.diagnostics.apiStatus.krakenSpot = "помилка WebSocket Kraken";
      logger.warn({ err }, "Помилка підключення Kraken WebSocket");
    }
  }

  private async scan() {
    if (this.scanning) return;
    this.syncPriorityWatchlistSymbols();
    if (Date.now() < this.bybitCooldownUntil) {
      state.diagnostics.apiStatus.bybit = `ліміт запитів; пауза до ${new Date(this.bybitCooldownUntil).toLocaleTimeString()}`;
      state.marketCondition = "Активна пауза через ліміт Bybit; сканер автоматично продовжить роботу";
      this.broadcast({ type: "state", state });
      return;
    }
    this.scanning = true;
    try {
      const btcCandles = await this.loadBtcCandles();
      const btcOk = btcStable(btcCandles);
      const candidates: Signal[] = [];
      const attempts = Math.min(3, this.symbols.length);
      for (let attempt = 0; attempt < attempts; attempt++) {
        const symbol = this.symbols[this.cursor % this.symbols.length];
        const requestedMode = Math.floor(this.cursor / this.symbols.length) % 2 === 0 ? "futures" : "spot";
        const mode = requestedMode === "spot" && !this.spotSymbols.has(symbol) ? "futures" : requestedMode;
        this.cursor += 1;
        try {
          const candles = symbol === "BTCUSDT" && mode === "futures" ? btcCandles : await this.loadCandles(symbol, mode);
          const snapshot = await this.snapshot(symbol, mode, candles, btcOk, btcCandles);
          const signal = buildSignal(snapshot);
          logger.info({ symbol, mode, side: signal.side, score: signal.score, winProbability: signal.winProbability, rejectionReason: signal.rejectionReason, scoreBreakdown: signal.scoreBreakdown }, "рішення сканера");
          recordSignal(signal);
          if (mode === "futures") updatePaperTradeMemory(signal.symbol, signal.currentPrice);
          candidates.push(signal);
          await this.trackWatchlist(signal);
          if (!["NO_TRADE", "WATCHLIST"].includes(signal.side) && this.canSendSignal(signal)) {
            if (smallBalanceCooldownActive()) {
              logger.info({ symbol, side: signal.side, cooldownMinutes: config.minSignalCooldownMinutes }, "small balance cooldown skipped signal send");
              break;
            }
            this.markSignalSent(signal);
            if (notificationsEnabled()) await this.notifier.signal(signal).catch((err) => logger.warn({ err }, "Не вдалося надіслати сигнал Telegram"));
            recordPaperOpen(signal);
          }
          break;
        } catch (symbolError) {
          logger.error({ err: symbolError, symbol, mode }, "Символ пропущено; сканер продовжує наступний символ");
          if (isRateLimit(symbolError)) {
            this.bybitCooldownUntil = Date.now() + 5 * 60 * 1000;
            state.diagnostics.apiStatus.bybit = "ліміт запитів; автоматична пауза активна";
            break;
          }
        }
      }
      await this.monitorActiveTrades(btcOk);
      state.diagnostics.lastScanAt = new Date().toISOString();
      state.diagnostics.scannedSymbols = this.symbols.length;
      state.marketCondition = summarize(candidates);
      this.broadcast({ type: "state", state });
    } catch (err) {
      if (isRateLimit(err)) {
        this.bybitCooldownUntil = Date.now() + 5 * 60 * 1000;
        state.diagnostics.apiStatus.bybit = "ліміт запитів; автоматична пауза активна";
        state.marketCondition = "Активна пауза через ліміт Bybit; сканер автоматично продовжить роботу";
        this.broadcast({ type: "state", state });
      }
      logger.error({ err }, "Помилка сканування");
    } finally {
      this.scanning = false;
    }
  }

  private canSendSignal(signal: Signal) {
    if (!isRealEntrySignal(signal)) return false;
    if (signalsPaused()) return false;
    const key = signalCooldownKey(signal);
    const prev = this.signalCooldown.get(key);
    if (!prev) return true;
    const cooldownMs = 25 * 60_000;
    const improved = signal.score >= prev.score + 8 || signal.score >= 92 && prev.score < 92;
    return Date.now() - prev.sentAt >= cooldownMs || improved;
  }

  private markSignalSent(signal: Signal) {
    this.signalCooldown.set(signalCooldownKey(signal), { score: signal.score, sentAt: Date.now() });
  }

  private syncPriorityWatchlistSymbols() {
    const priority = loadPriorityWatchlist();
    if (!priority.length) return;
    const merged = [...new Set([...this.symbols, ...priority])];
    if (merged.length !== this.symbols.length) {
      this.symbols = merged;
      state.diagnostics.validSymbols = [...new Set([...(state.diagnostics.validSymbols ?? []), ...priority])];
      logger.info({ priority }, "priority watchlist restored into scanner symbols");
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
      this.linearSymbols = linear;
      this.spotSymbols = spot;
      const valid = config.symbols.filter((s) => linear.has(s) || spot.has(s));
      const invalid = config.symbols.filter((s) => !linear.has(s) && !spot.has(s));
      this.symbols = valid.length ? valid : ["BTCUSDT"];
      state.diagnostics.validSymbols = this.symbols;
      state.diagnostics.invalidSymbols = invalid;
      state.diagnostics.apiStatus.bybit = "символи перевірено";
      logger.info({ validSymbols: this.symbols, invalidSymbols: invalid }, "Bybit symbol validation completed");
    } catch (err) {
      this.symbols = config.symbols;
      this.linearSymbols = new Set(config.symbols);
      this.spotSymbols = new Set(config.symbols);
      state.diagnostics.validSymbols = this.symbols;
      state.diagnostics.invalidSymbols = [];
      state.diagnostics.apiStatus.bybit = "використовується попередньо перевірений список символів";
      logger.warn({ err, validSymbols: this.symbols }, "Перевірка символів Bybit тимчасово недоступна; використовується попередньо перевірений список");
    }
  }

  private async validateOkxAuth() {
    if (config.partialMode) {
      state.diagnostics.apiStatus.okx = "часткове публічне підтвердження";
      return;
    }
    try {
      const auth = await this.client.okxAuthCheck();
      state.diagnostics.apiStatus.okx = "автентифіковано і підключено";
      delete state.diagnostics.authErrors.okx;
      logger.info({ accountLevel: auth.accountLevel, permissions: auth.permissions }, "Автентифікація OKX успішна");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.diagnostics.apiStatus.okx = "помилка автентифікації; public market confirmation активне";
      state.diagnostics.authErrors.okx = message;
      logger.error({ err }, "Помилка автентифікації OKX");
    }
  }

  private async validateKucoinAuth() {
    try {
      const auth = await this.client.kucoinAuthCheck();
      state.diagnostics.apiStatus.kucoin = auth.ok ? "автентифіковано і підключено" : "помилка автентифікації KuCoin";
      logger.info({ uid: auth.uid }, "Автентифікація KuCoin успішна");
    } catch (err) {
      state.diagnostics.apiStatus.kucoin = "помилка автентифікації KuCoin";
      logger.error({ err }, "Помилка автентифікації KuCoin");
    }
  }

  private async validateKrakenAuth() {
    try {
      const spot = await this.client.krakenSpotAuthCheck();
      state.diagnostics.apiStatus.krakenSpot = spot.ok ? "автентифіковано і підключено" : "помилка Kraken Spot";
      delete state.diagnostics.authErrors.krakenSpot;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.diagnostics.apiStatus.krakenSpot = "помилка Kraken Spot; public market confirmation активне";
      state.diagnostics.authErrors.krakenSpot = message;
      logger.error({ err }, "Помилка автентифікації Kraken Spot");
    }
    try {
      const futures = await this.client.krakenFuturesAuthCheck();
      state.diagnostics.apiStatus.krakenFutures = futures.ok ? "автентифіковано і підключено" : "помилка Kraken Futures";
      delete state.diagnostics.authErrors.krakenFutures;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.diagnostics.apiStatus.krakenFutures = "помилка Kraken Futures; public futures confirmation активне";
      state.diagnostics.authErrors.krakenFutures = message;
      logger.error({ err }, "Помилка автентифікації Kraken Futures");
    }
  }

  private async loadCandles(symbol: string, mode: "spot" | "futures"): Promise<Record<string, Candle[]>> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const category = mode === "spot" ? "spot" : "linear";
    const entries: Array<readonly [string, Candle[]]> = [];
    for (const tf of tfs) {
      const candles = await this.client.bybitKlines(symbol, tf, category);
      if (!Array.isArray(candles) || !candles.length) throw new Error(`Bybit candles empty ${symbol} ${tf} ${category}`);
      entries.push([tf, candles] as const);
      await sleep(150);
    }
    state.diagnostics.apiStatus.bybit = "підключено";
    return Object.fromEntries(entries);
  }

  private async snapshot(symbol: string, mode: "spot" | "futures", candles: Record<string, Candle[]>, btcOk: boolean, btcCandles: Record<string, Candle[]>): Promise<MarketSnapshot> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const [okxEntries, kucoinEntries, krakenEntries, binanceEntries, imbalance, funding, oi, correlation] = await Promise.all([
      Promise.all(tfs.map(async (tf) => [tf, await this.client.okxKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.kucoinKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.krakenSpotKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.binanceKlines(symbol, tf).catch(() => [])] as const)),
      mode === "futures" ? this.client.orderBookImbalance(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.fundingRate(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.openInterestChange(symbol).catch(() => 0) : Promise.resolve(0),
      this.correlationContext(symbol, mode, candles, btcCandles).catch((err) => {
        logger.warn({ err, symbol }, "Correlation context unavailable; using defensive neutral context");
        return neutralCorrelation();
      })
    ]);
    if (config.partialMode) state.diagnostics.apiStatus.okx = "часткове публічне підтвердження";
    else if (!state.diagnostics.apiStatus.okx.startsWith("помилка автентифікації")) state.diagnostics.apiStatus.okx = "автентифіковано і підключено; ринкове підтвердження активне";
    state.diagnostics.apiStatus.binance = "підключено";
    const primary = candles[mode === "futures" ? "15" : "240"] ?? [];
    const dollarVolume = primary.slice(-24).reduce((s, c) => s + c.volume * c.close, 0) / 24;
    const whaleScore = Math.min(100, Math.max(0, Math.abs(oi) * 2500 + Math.abs(imbalance) * 120));
    return {
      symbol,
      mode,
      candles,
      okxCandles: Object.fromEntries(okxEntries),
      kucoinCandles: Object.fromEntries(kucoinEntries),
      krakenCandles: Object.fromEntries(krakenEntries),
      binanceCandles: Object.fromEntries(binanceEntries),
      orderBookImbalance: imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore: Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11),
      whaleScore,
      btcStable: btcOk,
      regime: regimeFrom(candles),
      confirmations: exchangeConfirmations(candles, Object.fromEntries(okxEntries), Object.fromEntries(kucoinEntries), Object.fromEntries(krakenEntries), Object.fromEntries(binanceEntries), mode),
      correlation
    };
  }

  private async correlationContext(symbol: string, mode: "spot" | "futures", candles: Record<string, Candle[]>, btcCandles: Record<string, Candle[]>) {
    const category = mode === "spot" ? "spot" : "linear";
    const ethCandles = symbol === "ETHUSDT" ? candles : { "60": await this.client.bybitKlines("ETHUSDT", "60", category, 80).catch(() => []), "240": await this.client.bybitKlines("ETHUSDT", "240", category, 80).catch(() => []) };
    const btcDirection = directionOf(btcCandles["60"]);
    const ethDirection = directionOf(ethCandles["60"]);
    const btcHtf = directionOf(btcCandles["240"]);
    const ethHtf = directionOf(ethCandles["240"]);
    const riskOn = btcDirection >= 0 && ethDirection >= 0 && btcHtf >= 0 && ethHtf >= 0 && (btcDirection > 0 || ethDirection > 0);
    const riskOff = btcDirection <= 0 && ethDirection <= 0 && btcHtf <= 0 && ethHtf <= 0 && (btcDirection < 0 || ethDirection < 0);
    return {
      btcDirection,
      ethDirection,
      total3Direction: 0,
      btcDominanceDirection: 0,
      dxyDirection: 0,
      nasdaqDirection: 0,
      aligned: riskOn,
      riskOff,
      details: [`BTC 1H ${dirUa(btcDirection)}`, `BTC 4H ${dirUa(btcHtf)}`, `ETH 1H ${dirUa(ethDirection)}`, `ETH 4H ${dirUa(ethHtf)}`, "TOTAL3/DXY/NASDAQ: live source not configured, нейтрально"]
    };
  }

  private async monitorActiveTrades(btcOk: boolean) {
    for (const signal of state.activeSignals) {
      const category = signal.mode === "spot" ? "spot" : "linear";
      const tf = signal.mode === "spot" ? "60" : "5";
      const candles = await this.client.bybitKlines(signal.symbol, tf, category, 3).catch(() => []);
      const current = candles.at(-1)?.close ?? signal.currentPrice;
      const action = tradeManagementAction(signal, current, btcOk, this.managementSent);
      if (!action) continue;
      const key = `${signal.id}-${action.stage}`;
      if (this.managementSent.has(key)) continue;
      this.managementSent.add(key);
      if (action.stage === "TP1") recordTradeMemory(signal, "TP1", current);
      if (action.stage === "TP2") recordTradeMemory(signal, "TP2", current);
      if (action.stage === "TP3") { recordTradeMemory(signal, "TP3", current); recordProtectionOutcome("WIN"); recordLearningOutcome(signal, "TP"); recordPaperClose(signal, "WIN", 3); }
      if (action.stage === "SL") { recordTradeMemory(signal, "SL", current); recordProtectionOutcome("LOSS"); recordLearningOutcome(signal, signal.fakeBreakout.risk ? "FAKE_BREAKOUT" : "SL"); recordPaperClose(signal, "LOSS", -1); }
      logger.info({ symbol: signal.symbol, action: action.label, currentPrice: current, reasons: action.reasons }, "trade management alert");
      if (notificationsEnabled() && ["TP1", "TP2", "TP3", "SL"].includes(action.stage)) await this.notifier.tradeManagementAlert(signal, action.label, current, action.reasons).catch((err) => logger.warn({ err }, "Не вдалося надіслати Telegram-сповіщення управління угодою"));
    }
  }

  private async trackWatchlist(signal: Signal) {
    if (signal.mode !== "futures" || signal.score < 72 || signal.side !== "WATCHLIST") return;
    const key = watchKey(signal.symbol, signal.mode);
    if (this.watchlistSent.has(key)) return;
    this.watchlistSent.add(key);
    recordPaperSetup(signal);
    logger.info({ symbol: signal.symbol, score: signal.score }, "watchlist setup tracked silently");
  }

  private async monitorWatchlist() {
    const items = state.watchlist.filter((signal) => signal.mode === "futures" && signal.score >= 72);
    if (!items.length || Date.now() < this.bybitCooldownUntil) return;
    let btcCandles: Record<string, Candle[]>;
    try {
      btcCandles = await this.loadBtcCandles();
    } catch (err) {
      logger.warn({ err }, "Watchlist BTC filter unavailable");
      return;
    }
    const btcOk = btcStable(btcCandles);
    for (const item of items) {
      const key = watchKey(item.symbol, item.mode);
      if (this.activatedWatchlist.has(key) || this.invalidatedWatchlist.has(key)) continue;
      const recheckMs = isNewTokenWatch(item.symbol) ? 60_000 : 2 * 60_000;
      const checkedAt = this.watchlistCheckedAt.get(key) ?? 0;
      if (Date.now() - checkedAt < recheckMs) continue;
      this.watchlistCheckedAt.set(key, Date.now());
      try {
        const candles = item.symbol === "BTCUSDT" ? btcCandles : await this.loadCandles(item.symbol, "futures");
        const snapshot = await this.snapshot(item.symbol, "futures", candles, btcOk, btcCandles);
        const signal = buildSignal(snapshot);
        logger.info({ symbol: item.symbol, score: signal.score, side: signal.side, scoreBreakdown: signal.scoreBreakdown }, "watchlist recheck");
        const evolution = watchlistEvolution(item, signal);
        const fomo = fomoBlock(signal);
        const entryThreshold = signal.scoreBreakdown.adaptiveConfirmationRequired ?? 92;
        if (signal.score >= entryThreshold && fomo.blocked) {
          if (!this.fomoWatchlist.has(key)) {
            this.fomoWatchlist.add(key);
            if (notificationsEnabled()) await this.notifier.pumpDetected(signal, fomo.reasons);
          }
          state.watchlist = [signal, ...state.watchlist.filter((x) => watchKey(x.symbol, x.mode) !== key)].slice(0, 30);
          continue;
        }
        if (signal.score >= entryThreshold && activationConfirmed(signal, evolution) && isRealEntrySignal(signal)) {
          const activated = signal;
          this.activatedWatchlist.add(key);
          recordSignal(activated);
          this.markSignalSent(activated);
          if (notificationsEnabled()) await this.notifier.setupUpgraded(activated, activationReasons(activated, evolution));
          recordPaperOpen(activated);
          continue;
        }
        if (watchlistDecayed(item, signal, evolution)) {
          this.invalidatedWatchlist.add(key);
          state.watchlist = state.watchlist.filter((x) => watchKey(x.symbol, x.mode) !== key);
          const reasons = invalidationReasons(signal, evolution);
          logger.info({ symbol: signal.symbol, reasons }, "watchlist setup invalidated");
          if (notificationsEnabled()) await this.notifier.setupInvalidated(signal, reasons);
        } else {
          state.watchlist = [signal, ...state.watchlist.filter((x) => watchKey(x.symbol, x.mode) !== key)].slice(0, 30);
        }
      } catch (err) {
        logger.warn({ err, symbol: item.symbol }, "Watchlist recheck failed; keeping setup monitored");
      }
    }
    this.broadcast({ type: "state", state });
  }
}

export function activationConfirmed(signal: Signal, evolution: WatchlistEvolution) {
  const entryThreshold = signal.scoreBreakdown.adaptiveConfirmationRequired ?? 92;
  const confirmations = [
    momentumConfirmed(signal),
    volumeConfirmed(signal),
    orderBookConfirmed(signal),
    liquiditySweepConfirmed(signal),
    breakoutConfirmed(signal),
    sniperConfirmed(signal),
    signal.btcStable,
    evolution.oiImproved,
    evolution.volumeImproved
  ].filter(Boolean).length;
  const improvedEnough = evolution.scoreDelta >= 5 || [evolution.volumeImproved, evolution.momentumShift, evolution.retestImproved, evolution.oiImproved].filter(Boolean).length >= 2;
  return !isExpired(signal) && !["NO_TRADE", "WATCHLIST"].includes(signal.side) && signal.score >= entryThreshold && confirmations >= (improvedEnough ? 4 : 5) && improvedEnough && sniperConfirmed(signal) && (evolution.retestImproved || liquiditySweepConfirmed(signal)) && signal.btcStable && signal.entryStatus === "ENTER_NOW" && !fomoBlock(signal).blocked;
}

export type WatchlistEvolution = ReturnType<typeof watchlistEvolution>;

export function watchlistEvolution(prev: Signal, next: Signal) {
  const oldScore = prev.scoreBreakdown;
  const newScore = next.scoreBreakdown;
  const improved = (key: string, by = 8) => (newScore[key] ?? 0) >= (oldScore[key] ?? 0) + by;
  const faded = (key: string, by = 12) => (newScore[key] ?? 0) + by < (oldScore[key] ?? 0);
  return {
    scoreDelta: next.score - prev.score,
    oiImproved: improved("openInterestConfirmation", 5),
    volumeImproved: improved("volumeConfirmation", 8),
    momentumShift: improved("momentumQuality", 8),
    retestImproved: improved("liquiditySweep", 10) || (newScore.liquiditySweep ?? 0) >= 70,
    orderbookImproved: improved("orderBookImbalance", 8),
    breakoutImproved: improved("multiTimeframeAlignment", 10) || next.marketRegime === "BREAKOUT",
    volumeFaded: faded("volumeConfirmation"),
    oiFaded: faded("openInterestConfirmation", 8),
    momentumFaded: faded("momentumQuality"),
    orderbookFaded: faded("orderBookImbalance")
  };
}

function watchlistDecayed(prev: Signal, next: Signal, evolution: WatchlistEvolution) {
  if (next.score < 75) return true;
  if (!next.btcStable && next.symbol !== "BTCUSDT") return true;
  const faded = [evolution.volumeFaded, evolution.oiFaded, evolution.momentumFaded, evolution.orderbookFaded].filter(Boolean).length;
  return prev.score >= 82 && next.score < 72 || faded >= 3;
}

function activationReasons(signal: Signal, evolution: WatchlistEvolution) {
  const reasons = [`score оновився до ${signal.scoreBreakdown.adaptiveConfirmationRequired ?? 92}+`];
  if (evolution.scoreDelta > 0) reasons.push(`score покращився +${evolution.scoreDelta}`);
  if (evolution.volumeImproved || volumeConfirmed(signal)) reasons.push("volume increased");
  if (evolution.oiImproved || (signal.scoreBreakdown.openInterestConfirmation ?? 0) >= 58) reasons.push("OI rising");
  if (evolution.retestImproved || liquiditySweepConfirmed(signal)) reasons.push("retest confirmed");
  if (orderBookConfirmed(signal)) reasons.push("orderbook improved");
  if (sniperConfirmed(signal)) reasons.push("sniper trigger");
  if (signal.btcStable) reasons.push("BTC stable");
  if (breakoutConfirmed(signal)) reasons.push("breakout confirmation");
  return reasons;
}

function isNewTokenWatch(symbol: string) {
  return !config.symbols.includes(symbol);
}

function invalidationReasons(signal: Signal, evolution?: WatchlistEvolution) {
  const reasons: string[] = [];
  if (evolution?.volumeFaded || !volumeConfirmed(signal)) reasons.push("volume weakened");
  if (evolution?.oiFaded) reasons.push("OI dropped");
  if (evolution?.momentumFaded || !momentumConfirmed(signal)) reasons.push("momentum weakened");
  if (evolution?.orderbookFaded) reasons.push("orderbook weakened");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") reasons.push("BTC unstable");
  if (signal.marketRegime === "MANIPULATION_RISK") reasons.push("fake breakout risk");
  return reasons.length ? reasons : [signal.rejectionReason || `score dropped to ${signal.score}/100`];
}

export function fomoBlock(signal: Signal) {
  const reasons: string[] = [];
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  const outsideEntryZone = signal.side === "SHORT" ? signal.currentPrice < entryLow * 0.995 : signal.currentPrice > entryHigh * 1.005;
  if (signal.fakeBreakout.risk) reasons.push("fake breakout / manipulation risk");
  if (!signal.fastMoveQuality.clean || signal.fastMoveQuality.score < 45) reasons.push("parabolic candle / vertical move");
  if (signal.marketRegime === "MANIPULATION_RISK" || signal.marketRegime === "NEWS_DRIVEN") reasons.push("market overheated");
  if (outsideEntryZone || signal.entryStatus !== "ENTER_NOW") reasons.push("price not in smart entry zone");
  return { blocked: reasons.length > 0, reasons };
}

function momentumConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.momentumQuality ?? 0) >= 70;
}

function smcConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.smcConfirmation ?? 0) >= 40;
}

function volumeConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.volumeConfirmation ?? 0) >= 65;
}

function orderBookConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.orderBookImbalance ?? 0) >= 60;
}

function liquiditySweepConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.liquiditySweep ?? 0) >= 70;
}

function sniperConfirmed(signal: Signal) {
  return (signal.scoreBreakdown.entrySniper ?? 0) >= 70;
}

function breakoutConfirmed(signal: Signal) {
  return signal.marketRegime !== "MANIPULATION_RISK" && (signal.scoreBreakdown.multiTimeframeAlignment ?? 0) >= 65 && (signal.scoreBreakdown.trendStrength ?? 0) >= 45;
}

function watchKey(symbol: string, mode: string) {
  return `${symbol}-${mode}`;
}

function exchangeConfirmations(bybit: Record<string, Candle[]>, okx: Record<string, Candle[]>, kucoin: Record<string, Candle[]>, kraken: Record<string, Candle[]>, binance: Record<string, Candle[]>, mode: "spot" | "futures") {
  const tf = mode === "futures" ? "15" : "240";
  const bybitDir = directionOf(bybit[tf]);
  const okxDir = directionOf(okx[tf]);
  const kucoinDir = directionOf(kucoin[tf]);
  const krakenDir = directionOf(kraken[tf]);
  const binanceDir = directionOf(binance[tf]);
  const okxAligned = okxDir !== 0 && okxDir === bybitDir;
  const kucoinAligned = kucoinDir !== 0 && kucoinDir === bybitDir;
  const krakenAligned = krakenDir !== 0 && krakenDir === bybitDir;
  const binanceAligned = binanceDir !== 0 && binanceDir === bybitDir;
  const conflict = [okxDir, kucoinDir, krakenDir].some((dir) => dir !== 0 && bybitDir !== 0 && dir !== bybitDir);
  return {
    bybit: bybitDir !== 0,
    okx: okxAligned,
    kucoin: kucoinAligned,
    kraken: krakenAligned,
    binance: binanceAligned,
    alignedCount: [bybitDir !== 0, okxAligned, kucoinAligned, krakenAligned, binanceAligned].filter(Boolean).length,
    conflict,
    details: [`Bybit: ${dirUa(bybitDir)}`, `OKX: ${dirUa(okxDir)}`, `KuCoin: ${dirUa(kucoinDir)}`, `Kraken: ${dirUa(krakenDir)}`, `Binance: ${dirUa(binanceDir)}`]
  };
}

function directionOf(candles: Candle[] | undefined) {
  if (!candles || candles.length < 55) return 0;
  const recent = candles.at(-1)!;
  const prev = candles.at(-20)!;
  if (recent.close > prev.close) return 1;
  if (recent.close < prev.close) return -1;
  return 0;
}

function dirUa(dir: number) {
  return dir > 0 ? "вгору" : dir < 0 ? "вниз" : "немає даних";
}

function neutralCorrelation() {
  return { btcDirection: 0, ethDirection: 0, total3Direction: 0, btcDominanceDirection: 0, dxyDirection: 0, nasdaqDirection: 0, aligned: false, riskOff: false, details: ["correlation data unavailable"] };
}

function tradeManagementAction(signal: Signal, current: number, btcOk: boolean, sent: Set<string>) {
  const long = signal.side === "LONG" || signal.side === "BUY";
  const short = signal.side === "SHORT";
  if (!long && !short) return null;
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  const entered = signal.entryStatus === "ENTER_NOW" || (current >= entryLow && current <= entryHigh);
  if (!entered && isExpired(signal)) return { stage: "EXPIRED", label: `EXPIRED — ${signal.symbol}`, reasons: [] };
  if (!entered) return null;
  if (!sent.has(`${signal.id}-ENTRY`)) return { stage: "ENTRY", label: `ENTRY OPENED — ${signal.symbol}`, reasons: [] };
  if ((long && current <= signal.stopLoss) || (short && current >= signal.stopLoss)) return { stage: "SL", label: `❌ Stop loss hit — ${signal.symbol}\n🏁 Trade closed`, reasons: [] };
  if (!btcOk && signal.symbol !== "BTCUSDT") return { stage: "BTC_RISK", label: `BTC risk — ${signal.symbol}`, reasons: [] };
  if ((long && current >= signal.takeProfit[2]) || (short && current <= signal.takeProfit[2])) return { stage: "TP3", label: `🏁 Trade closed — ${signal.symbol}\n✅ TP3 HIT`, reasons: [] };
  if ((long && current >= signal.takeProfit[1]) || (short && current <= signal.takeProfit[1])) return { stage: "TP2", label: `✅ TP2 HIT — ${signal.symbol}`, reasons: [] };
  if ((long && current >= signal.takeProfit[0]) || (short && current <= signal.takeProfit[0])) {
    const move = shouldMoveToBreakeven(signal);
    return { stage: "TP1", label: `✅ TP1 HIT — ${signal.symbol}${move ? "\n🛡 Breakeven activated" : ""}`, reasons: [] };
  }
  return null;
}

function shouldMoveToBreakeven(signal: Signal) {
  const momentum = signal.scoreBreakdown.momentumQuality ?? 0;
  const volume = signal.scoreBreakdown.volumeConfirmation ?? 0;
  const orderFlow = signal.scoreBreakdown.cvdOrderFlow ?? 0;
  const fast = signal.fastMoveQuality.score ?? 0;
  const volatile = signal.marketRegime === "VOLATILE" || signal.marketRegime === "NEWS_DRIVEN";
  const structure = signal.scoreBreakdown.smcConfirmation ?? 0;
  if (!signal.btcStable || volatile || momentum < 70 || volume < 55 || orderFlow < 45 || structure < 35) return true;
  if (momentum >= 82 && volume >= 70 && fast >= 65 && orderFlow >= 60 && structure >= 45) return false;
  return true;
}

function isExpired(signal: Signal) {
  return Date.parse(signal.expiresAt) <= Date.now();
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

function signalCooldownKey(s: Signal) {
  return `${s.symbol}-${s.mode}-${s.side}`;
}

function smallBalanceCooldownActive() {
  if (!config.smallBalanceGrowthMode) return false;
  const last = state.activeSignals[0];
  if (!last) return false;
  return Date.now() - Date.parse(last.createdAt) < config.minSignalCooldownMinutes * 60_000;
}

function summarize(signals: Signal[]) {
  const risk = signals.some((s) => s.marketRegime === "MANIPULATION_RISK");
  if (risk) return "⚠️ РИНОК ВИСОКОГО РИЗИКУ — НЕ ВХОДИТИ";
  const best = signals.sort((a, b) => b.score - a.score)[0];
  return best ? `Режим ринку: ${regimeUa(best.marketRegime)}. Найсильніший сетап: ${best.symbol} ${sideUa(best.side)} ${best.score}/100` : "Якісних ринкових даних ще немає";
}

function sideUa(side: Signal["side"]) {
  return side === "NO_TRADE" ? "НЕ ВХОДИТИ" : side === "WATCHLIST" ? "СПОСТЕРЕЖЕННЯ" : side;
}

function regimeUa(regime: Signal["marketRegime"]) {
  const map: Record<Signal["marketRegime"], string> = { TRENDING: "трендовий", SIDEWAYS: "боковий", BREAKOUT: "breakout", REVERSAL: "reversal", HIGH_VOLATILITY: "висока волатильність", LOW_VOLATILITY: "низька волатильність", CHOPPY: "шумний", RANGING: "боковий", EXPANSION: "розширення", COMPRESSION: "стиснення", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}
