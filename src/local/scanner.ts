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
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "./bots";
import { MomentumScanner } from "./momentumScanner";
import { analyzeMomentumHunter, formatMomentumDashboard, formatMomentumDetail } from "./engines/MomentumHunterEngine";
import { recordMomentum, recordMomentumExit } from "./state";

type Broadcast = (payload: unknown) => void;

export class Scanner {
  private client = new ExchangeClient();
  private notifier = new TelegramNotifier();
  private timer: NodeJS.Timeout | null = null;
  private watchlistTimer: NodeJS.Timeout | null = null;
  private momentumTimer: NodeJS.Timeout | null = null;
  private started = false;
  private signalCooldown = new Map<string, { score: number; sentAt: number }>();
  private watchlistSent = new Set<string>();
  private activatedWatchlist = new Set<string>();
  private invalidatedWatchlist = new Set<string>();
  private fomoWatchlist = new Set<string>();
  private watchlistCheckedAt = new Map<string, number>();
  private symbolScannedAt = new Map<string, number>();
  private binanceWs: WebSocket | null = null;
  private scanning = false;
  private watchlistMonitoring = false;
  private momentumScanning = false;
  private symbols = config.symbols;
  private cursor = 0;
  private managementSent = new Set<string>();
  private bybitCooldownUntil = 0;
  private btcCache: { candles: Record<string, Candle[]>; expiresAt: number } | null = null;
  private linearSymbols = new Set<string>();
  private spotSymbols = new Set<string>();
  private pumpDetector = new PumpDetectorBot();
  private whaleTracker = new WhaleTrackerBot();
  private liqBot = new LiqBot();
  private marketReportBot = new MarketReportBot();
  private momentumScanner = new MomentumScanner();

  constructor(private broadcast: Broadcast) {}

  async start() {
    if (this.started) {
      logger.info("Scanner already running; duplicate start skipped");
      return;
    }
    this.started = true;
    await this.notifier.started().catch((err) => {
      state.diagnostics.apiStatus.telegram = "помилка";
      logger.warn({ err }, "Не вдалося надіслати стартове повідомлення Telegram");
    });
    state.diagnostics.apiStatus.telegram = "налаштовано";
    await this.validateOkxAuth();
    await this.validateKucoinAuth();
    await this.validateSymbols();
    this.connectBinanceTicker();
    this.connectKucoinTicker();
    this.timer = setInterval(() => void this.scan(), Math.min(config.SCAN_INTERVAL_SECONDS * 1000, 10_000));
    this.watchlistTimer = setInterval(() => void this.monitorWatchlist(), 20_000);
    void this.scanMomentumMoves();
    this.momentumTimer = setInterval(() => void this.scanMomentumMoves(), 15_000);
    void this.scan();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watchlistTimer) clearInterval(this.watchlistTimer);
    if (this.momentumTimer) clearInterval(this.momentumTimer);
    this.timer = null;
    this.watchlistTimer = null;
    this.momentumTimer = null;
    this.started = false;
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
      const targets = this.nextScanTargets();
      for (const target of targets) {
        const symbolStartedAt = Date.now();
        const { symbol } = target;
        const requestedMode = target.mode;
        const mode = requestedMode === "spot" && !this.spotSymbols.has(symbol) ? "futures" : requestedMode;
        this.symbolScannedAt.set(scanKey(symbol, mode), symbolStartedAt);
        try {
          const candles = symbol === "BTCUSDT" && mode === "futures" ? btcCandles : await this.loadCandles(symbol, mode);
          const marketDataFetchedAt = Date.now();
          const snapshot = await this.snapshot(symbol, mode, candles, btcOk, btcCandles);
          const snapshotReadyAt = Date.now();
          const signal = buildSignal(snapshot);
          const signalConfirmedAt = Date.now();
          logger.info({
            symbol,
            mode,
            side: signal.side,
            score: signal.score,
            winProbability: signal.winProbability,
            confidence: signal.confidence,
            entryStatus: signal.entryStatus,
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            riskReward: signal.riskReward,
            leverage: signal.leverage,
            positionSizing: signal.positionSizing ? {
              positionSizeUsdt: signal.positionSizing.positionSizeUsdt,
              marginUsdt: signal.positionSizing.marginUsdt,
              quantity: signal.positionSizing.quantity,
              leverage: signal.positionSizing.leverage
            } : null,
            rejectionReason: signal.rejectionReason,
            marketRegime: signal.marketRegime,
            btcStable: signal.btcStable,
            scoreBreakdown: {
              trendStrength: signal.scoreBreakdown.trendStrength,
              momentumQuality: signal.scoreBreakdown.momentumQuality,
              volumeConfirmation: signal.scoreBreakdown.volumeConfirmation,
              liquiditySweep: signal.scoreBreakdown.liquiditySweep,
              entrySniper: signal.scoreBreakdown.entrySniper,
              orderBookImbalance: signal.scoreBreakdown.orderBookImbalance,
              multiTimeframeAlignment: signal.scoreBreakdown.multiTimeframeAlignment,
              higherTimeframeBias: signal.scoreBreakdown.higherTimeframeBias,
              fakeBreakoutProtection: signal.scoreBreakdown.fakeBreakoutProtection,
              cvdOrderFlow: signal.scoreBreakdown.cvdOrderFlow,
              smartOpenInterest: signal.scoreBreakdown.smartOpenInterest,
              smcConfirmation: signal.scoreBreakdown.smcConfirmation,
              fundingConfirmation: signal.scoreBreakdown.fundingConfirmation,
              openInterestConfirmation: signal.scoreBreakdown.openInterestConfirmation,
              adaptiveConfirmationRequired: signal.scoreBreakdown.adaptiveConfirmationRequired
            },
            latencyMs: {
              marketDataFetch: marketDataFetchedAt - symbolStartedAt,
              snapshot: snapshotReadyAt - marketDataFetchedAt,
              confirmation: signalConfirmedAt - snapshotReadyAt,
              detectedToConfirmed: signalConfirmedAt - symbolStartedAt
            }
          }, "рішення сканера");
          if (mode === "futures") {
            const momentumData = state.momentum.latestBySymbol[symbol];
            if (momentumData) {
              logger.info(`\n${formatMomentumDashboard(momentumData)}\n${formatMomentumDetail(momentumData)}`);
            }
          }
          recordSignal(signal);
          if (mode === "futures") updatePaperTradeMemory(signal.symbol, signal.currentPrice);
          candidates.push(signal);
          if (!["NO_TRADE", "WATCHLIST"].includes(signal.side) && this.canSendSignal(signal)) {
            this.markSignalSent(signal);
            if (notificationsEnabled()) await this.sendRealEntryFast(signal, { symbolStartedAt, marketDataFetchedAt, snapshotReadyAt, signalConfirmedAt });
            recordPaperOpen(signal);
          }
          await this.trackWatchlist(signal);
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

  private async sendRealEntryFast(signal: Signal, times: { symbolStartedAt: number; marketDataFetchedAt: number; snapshotReadyAt: number; signalConfirmedAt: number }) {
    const telegramSendStartedAt = Date.now();
    logger.info({ symbol: signal.symbol, side: signal.side, entryStatus: signal.entryStatus, marketDetectedAt: new Date(times.symbolStartedAt).toISOString(), signalConfirmedAt: new Date(times.signalConfirmedAt).toISOString(), telegramSendStartedAt: new Date(telegramSendStartedAt).toISOString(), latencyMs: { marketDataFetch: times.marketDataFetchedAt - times.symbolStartedAt, snapshot: times.snapshotReadyAt - times.marketDataFetchedAt, confirmation: times.signalConfirmedAt - times.snapshotReadyAt, queueDelay: telegramSendStartedAt - times.signalConfirmedAt } }, "real entry latency: sending stage 1 now");
    try {
      await this.notifier.instantEntry(signal);
      const telegramSentAt = Date.now();
      logger.info({ symbol: signal.symbol, side: signal.side, marketDetectedAt: new Date(times.symbolStartedAt).toISOString(), signalConfirmedAt: new Date(times.signalConfirmedAt).toISOString(), telegramSendStartedAt: new Date(telegramSendStartedAt).toISOString(), telegramSentAt: new Date(telegramSentAt).toISOString(), latencyMs: { marketDataFetch: times.marketDataFetchedAt - times.symbolStartedAt, snapshot: times.snapshotReadyAt - times.marketDataFetchedAt, confirmation: times.signalConfirmedAt - times.snapshotReadyAt, queueDelay: telegramSendStartedAt - times.signalConfirmedAt, telegramApi: telegramSentAt - telegramSendStartedAt, telegramSend: telegramSentAt - times.signalConfirmedAt, totalDetectedToTelegram: telegramSentAt - times.symbolStartedAt } }, "real entry latency: stage 1 sent");
      setTimeout(() => {
        void this.notifier.signal(signal).catch((err) => logger.warn({ err, symbol: signal.symbol }, "Не вдалося надіслати stage 2 signal details"));
      }, 2_500);
    } catch (err) {
      logger.warn({ err, symbol: signal.symbol }, "Не вдалося надіслати stage 1 instant entry Telegram");
      await this.notifier.signal(signal).catch((error) => logger.warn({ err: error, symbol: signal.symbol }, "Не вдалося надіслати fallback detailed signal Telegram"));
    }
  }

  private nextScanTargets() {
    const now = Date.now();
    const priority = new Set(loadPriorityWatchlist());
    const watch = new Set(state.watchlist.map((signal) => signal.symbol));
    const near = new Set(state.watchlist.filter(nearEntryTrigger).map((signal) => signal.symbol));
    const symbols = [...new Set([...near, ...priority, ...watch, ...this.symbols])];
    const due = symbols
      .map((symbol) => {
        const mode: "futures" | "spot" = this.linearSymbols.has(symbol) || priority.has(symbol) || watch.has(symbol) ? "futures" : "spot";
        const interval = near.has(symbol) || priority.has(symbol) ? 15_000 : watch.has(symbol) ? 25_000 : 90_000;
        const last = this.symbolScannedAt.get(scanKey(symbol, mode)) ?? 0;
        const urgency = (now - last) / interval + (near.has(symbol) ? 3 : priority.has(symbol) ? 2 : watch.has(symbol) ? 1 : 0);
        return { symbol, mode, due: now - last >= interval, urgency };
      })
      .filter((item) => item.due)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, 2);
    if (due.length) return due;
    const symbol = this.symbols[this.cursor % this.symbols.length];
    const requestedMode: "futures" | "spot" = Math.floor(this.cursor / this.symbols.length) % 2 === 0 ? "futures" : "spot";
    this.cursor += 1;
    return [{ symbol, mode: requestedMode, due: true, urgency: 0 }];
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
      state.diagnostics.authErrors.okx = redactedOkxStartupError(message);
      logger.error({ okxError: redactedOkxStartupError(message) }, "Помилка автентифікації OKX; перевірте OKX_API_KEY, OKX_SECRET_KEY та OKX_PASSPHRASE у .env");
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

  private async loadCandles(symbol: string, mode: "spot" | "futures"): Promise<Record<string, Candle[]>> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const category = mode === "spot" ? "spot" : "linear";
    const entries: Array<readonly [string, Candle[]]> = [];
    for (const tf of tfs) {
      const candles = await this.client.bybitKlines(symbol, tf, category);
      if (!Array.isArray(candles) || !candles.length) throw new Error(`Bybit candles empty ${symbol} ${tf} ${category}`);
      entries.push([tf, candles] as const);
    }
    state.diagnostics.apiStatus.bybit = "підключено";
    return Object.fromEntries(entries);
  }

  private async snapshot(symbol: string, mode: "spot" | "futures", candles: Record<string, Candle[]>, btcOk: boolean, btcCandles: Record<string, Candle[]>): Promise<MarketSnapshot> {
    const tfs = mode === "futures" ? ["15"] : config.spotTimeframes;
    const [okxEntries, kucoinEntries, binanceEntries, orderBook, funding, oi] = await Promise.all([
      mode === "futures" ? Promise.resolve([]) : Promise.all(tfs.map(async (tf) => [tf, await this.client.okxKlines(symbol, tf).catch(() => [])] as const)),
      mode === "futures" ? Promise.resolve([]) : Promise.all(tfs.map(async (tf) => [tf, await this.client.kucoinKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await withTimeout(this.client.binanceKlines(symbol, tf), 1_500, [])] as const)),
      mode === "futures" ? withTimeout(this.client.bybitOrderBookStats(symbol), 1_500, { spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false }) : Promise.resolve({ spreadPct: 0, depthUsdt: 0, imbalance: 0, spoofRisk: false }),
      mode === "futures" ? withTimeout(this.client.fundingRate(symbol), 1_000, 0) : Promise.resolve(0),
      mode === "futures" ? withTimeout(this.client.openInterestChange(symbol), 1_500, 0) : Promise.resolve(0)
    ]);
    const correlation = neutralCorrelation();
    if (config.partialMode) state.diagnostics.apiStatus.okx = "часткове публічне підтвердження";
    else if (!state.diagnostics.apiStatus.okx.startsWith("помилка автентифікації")) state.diagnostics.apiStatus.okx = "автентифіковано і підключено; ринкове підтвердження активне";
    state.diagnostics.apiStatus.binance = "підключено";
    const primary = candles[mode === "futures" ? "15" : "240"] ?? [];
    const dollarVolume = primary.slice(-24).reduce((s, c) => s + c.volume * c.close, 0) / 24;
    const liquidityScore = Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
    const regime = regimeFrom(candles);
    const intelligenceInput = { symbol, candles, orderBook, fundingRate: funding, openInterestChange: oi, liquidityScore, btcStable: btcOk, regime };
    const intelligence = mode === "futures" ? {
      pump: this.pumpDetector.analyze(intelligenceInput),
      whale: this.whaleTracker.analyze(intelligenceInput),
      liq: this.liqBot.analyze(intelligenceInput),
      market: this.marketReportBot.analyze(intelligenceInput),
      updatedAt: new Date().toISOString()
    } : undefined;
    const whaleScore = intelligence ? intelligence.whale.smartMoneyScore : Math.min(100, Math.max(0, Math.abs(oi) * 2500 + Math.abs(orderBook.imbalance) * 120));
    if (intelligence) {
      state.intelligence.latestBySymbol[symbol] = intelligence;
      state.intelligence.marketReport = intelligence.market;
      state.intelligence.updatedAt = intelligence.updatedAt;
    }
    if (mode === "futures") {
      try {
        const momentumOutput = analyzeMomentumHunter({
          symbol,
          candles,
          orderBookImbalance: orderBook.imbalance,
          orderBookDepthUsdt: orderBook.depthUsdt,
          orderBookSpoofRisk: orderBook.spoofRisk,
          fundingRate: funding,
          openInterestChange: oi,
          openInterestAbsolute: 0,
          accountRatio: 0,
          liquidityScore,
          regime
        });
        recordMomentum(symbol, momentumOutput);
        logger.info({
          symbol,
          pumpProbability: momentumOutput.pumpProbability,
          momentumScore: momentumOutput.momentumScore,
          whaleScore: momentumOutput.smartMoneyScore,
          decision: momentumOutput.decision,
          entryTiming: momentumOutput.entryTiming,
          mtf: momentumOutput.multiTimeframeAlignment,
          decisionReason: momentumOutput.decisionReason
        }, "Momentum Hunter analysis");
      } catch (momentumErr) {
        logger.warn({ err: momentumErr, symbol }, "Momentum Hunter analysis failed");
      }
    }
    return {
      symbol,
      mode,
      candles,
      okxCandles: Object.fromEntries(okxEntries),
      kucoinCandles: Object.fromEntries(kucoinEntries),
      binanceCandles: Object.fromEntries(binanceEntries),
      orderBookImbalance: orderBook.imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore,
      whaleScore,
      btcStable: btcOk,
      regime,
      confirmations: exchangeConfirmations(candles, Object.fromEntries(okxEntries), Object.fromEntries(kucoinEntries), Object.fromEntries(binanceEntries), mode),
      correlation,
      intelligence
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
    if (this.watchlistMonitoring) return;
    const items = state.watchlist.filter((signal) => signal.mode === "futures" && signal.score >= 72);
    if (!items.length || Date.now() < this.bybitCooldownUntil) return;
    this.watchlistMonitoring = true;
    let btcCandles: Record<string, Candle[]>;
    try {
      btcCandles = await this.loadBtcCandles();
    } catch (err) {
      logger.warn({ err }, "Watchlist BTC filter unavailable");
      this.watchlistMonitoring = false;
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
          const symbolStartedAt = Date.now();
          const candles = item.symbol === "BTCUSDT" ? btcCandles : await this.loadCandles(item.symbol, "futures");
          const marketDataFetchedAt = Date.now();
          const snapshot = await this.snapshot(item.symbol, "futures", candles, btcOk, btcCandles);
          const snapshotReadyAt = Date.now();
          const signal = buildSignal(snapshot);
          const signalConfirmedAt = Date.now();
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
          logger.info({ symbol: activated.symbol, side: activated.side, score: activated.score, reasons: activationReasons(activated, evolution), latencyMs: { marketDataFetch: marketDataFetchedAt - symbolStartedAt, snapshot: snapshotReadyAt - marketDataFetchedAt, confirmation: signalConfirmedAt - snapshotReadyAt, detectedToConfirmed: signalConfirmedAt - symbolStartedAt } }, "watchlist setup upgraded to real entry");
          if (notificationsEnabled()) await this.sendRealEntryFast(activated, { symbolStartedAt, marketDataFetchedAt, snapshotReadyAt, signalConfirmedAt });
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
    this.watchlistMonitoring = false;
  }

  private async scanMomentumMoves() {
    if (this.momentumScanning || Date.now() < this.bybitCooldownUntil || !notificationsEnabled()) return;
    this.momentumScanning = true;
    const startedAt = Date.now();
    try {
      const safeMoves = await this.momentumScanner.scanAutoSignals(3);
      const scalpMoves = await this.momentumScanner.scanAutoScalpSignals(2);
      const moves = [...safeMoves, ...scalpMoves].sort((a, b) => b.score - a.score).slice(0, 4);
      let btcCandles: Record<string, Candle[]> | null = null;
      let btcOk = true;
      for (const move of moves) {
        logger.info({ symbol: move.symbol, direction: move.direction, mode: move.mode ?? "SAFE", score: move.score, setupType: move.setupType, movePct: move.movePct }, "auto momentum candidate tracked silently");
        const momentumData = state.momentum.latestBySymbol[move.symbol];
        if (momentumData) logger.info(`\nMOMENTUM HUNTER: ${move.symbol}\nPump Probability: ${momentumData.pumpProbability}% | Momentum: ${momentumData.momentumScore} | Whale: ${momentumData.smartMoneyScore} | Decision: ${momentumData.decision}`);
        if (move.score >= 85) {
          try {
            if (!btcCandles) { btcCandles = await this.loadBtcCandles(); btcOk = btcStable(btcCandles); }
            const candles = await this.loadCandles(move.symbol, "futures");
            const snapshot = await this.snapshot(move.symbol, "futures", candles, btcOk, btcCandles);
            const signal = buildSignal(snapshot);
            logger.info({ symbol: signal.symbol, side: signal.side, score: signal.score, entryStatus: signal.entryStatus, momentumScore: move.score, setupType: move.setupType }, "momentum candidate → signal built");
            if (!["NO_TRADE", "WATCHLIST"].includes(signal.side) && this.canSendSignal(signal)) {
              this.markSignalSent(signal);
              logger.info({ symbol: signal.symbol, side: signal.side, score: signal.score, price: signal.currentPrice }, "ORDER SUBMITTED");
              if (notificationsEnabled()) await this.sendRealEntryFast(signal, {
                symbolStartedAt: startedAt,
                marketDataFetchedAt: startedAt,
                snapshotReadyAt: Date.now(),
                signalConfirmedAt: Date.now()
              });
              recordPaperOpen(signal);
              logger.info({ symbol: signal.symbol, side: signal.side, entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit }, "POSITION OPENED");
            } else {
              logger.info({ symbol: signal.symbol, side: signal.side, score: signal.score, rejectionReason: signal.rejectionReason, entryStatus: signal.entryStatus }, "momentum candidate rejected by signal validation");
            }
          } catch (signalErr) {
            logger.warn({ err: signalErr, symbol: move.symbol }, "Failed to build signal for momentum candidate");
          }
        }
      }
      state.diagnostics.apiStatus.autoSignals = `active; cycle ${Date.now() - startedAt}ms; safe ${safeMoves.length}; scalp ${scalpMoves.length}`;
    } catch (err) {
      state.diagnostics.apiStatus.autoSignals = "skipped; market data unavailable";
      logger.warn({ err }, "Auto signal scanner skipped");
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 10_000) logger.warn({ elapsed }, "Auto signal scan exceeded target cycle time");
      this.momentumScanning = false;
    }
  }
}

function redactedOkxStartupError(message: string) {
  if (/50105|passphrase|60024/i.test(message)) return "OKX authentication failed: wrong passphrase for the configured API key (50105/60024).";
  if (/50113|signature/i.test(message)) return "OKX authentication failed: signature rejected. Check OKX_SECRET_KEY.";
  if (/50102|timestamp/i.test(message)) return "OKX authentication failed: timestamp outside OKX window.";
  if (/incomplete/i.test(message)) return "OKX authentication failed: credentials incomplete in .env.";
  return message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 240);
}

export function activationConfirmed(signal: Signal, _evolution: WatchlistEvolution) {
  const entryThreshold = signal.scoreBreakdown.adaptiveConfirmationRequired ?? 92;
  return !isExpired(signal) && !["NO_TRADE", "WATCHLIST"].includes(signal.side) && signal.score >= entryThreshold && signal.btcStable && signal.entryStatus === "ENTER_NOW" && !fomoBlock(signal).blocked;
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

function scanKey(symbol: string, mode: string) {
  return `${symbol}-${mode}`;
}

function nearEntryTrigger(signal: Signal) {
  if (signal.side === "NO_TRADE" || signal.mode !== "futures" || !signal.btcStable || signal.fakeBreakout.risk) return false;
  const low = Math.min(...signal.entry);
  const high = Math.max(...signal.entry);
  const band = Math.max((high - low) * 0.75, signal.currentPrice * 0.0025);
  const nearZone = signal.currentPrice >= low - band && signal.currentPrice <= high + band;
  const microReady = (signal.scoreBreakdown.earlyEntryReady ?? 0) > 0 || (signal.scoreBreakdown.microConfirmationScore ?? 0) >= 78;
  return nearZone && signal.score >= 78 && (microReady || signal.entryStatus === "EARLY_ENTRY_READY" || signal.entryStatus === "WAIT_FOR_ENTRY");
}

function exchangeConfirmations(bybit: Record<string, Candle[]>, okx: Record<string, Candle[]>, kucoin: Record<string, Candle[]>, binance: Record<string, Candle[]>, mode: "spot" | "futures") {
  const tf = mode === "futures" ? "15" : "240";
  const bybitDir = directionOf(bybit[tf]);
  const okxDir = directionOf(okx[tf]);
  const kucoinDir = directionOf(kucoin[tf]);
  const binanceDir = directionOf(binance[tf]);
  const okxAligned = okxDir !== 0 && okxDir === bybitDir;
  const kucoinAligned = kucoinDir !== 0 && kucoinDir === bybitDir;
  const binanceAligned = binanceDir !== 0 && binanceDir === bybitDir;
  const conflict = [okxDir, kucoinDir].some((dir) => dir !== 0 && bybitDir !== 0 && dir !== bybitDir);
  return {
    bybit: bybitDir !== 0,
    okx: okxAligned,
    kucoin: kucoinAligned,
    binance: binanceAligned,
    alignedCount: [bybitDir !== 0, okxAligned, kucoinAligned, binanceAligned].filter(Boolean).length,
    conflict,
    details: [`Bybit: ${dirUa(bybitDir)}`, `OKX: ${dirUa(okxDir)}`, `KuCoin: ${dirUa(kucoinDir)}`, `Binance: ${dirUa(binanceDir)}`]
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function isRateLimit(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Access too frequent") || message.includes("Too many visits") || message.includes("retCode\":10006") || message.includes("403 Forbidden") || message.includes("429");
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
  if (!best) return "Якісних ринкових даних ще немає";
  return [
    "📈 Ринок:",
    `Режим: ${regimeUa(best.marketRegime)}`,
    "",
    "🏆 Найкращий кандидат:",
    best.symbol,
    "",
    `Оцінка сетапу: ${best.score}/100`,
    `Впевненість входу: ${best.confidence}/100`,
    "",
    best.side === "NO_TRADE" || best.entryStatus !== "ENTER_NOW" ? "❌ ЗАРАЗ НЕ ВХОДИТИ" : `✅ ${sideUa(best.side)}`,
    "",
    "Причина:",
    ...marketBlockReasons(best).map((reason) => `• ${reason}`)
  ].join("\n");
}

function sideUa(side: Signal["side"]) {
  return side === "NO_TRADE" ? "НЕ ВХОДИТИ" : side === "WATCHLIST" ? "СПОСТЕРЕЖЕННЯ" : side;
}

function regimeUa(regime: Signal["marketRegime"]) {
  const map: Record<Signal["marketRegime"], string> = { TRENDING: "трендовий", SIDEWAYS: "боковий", BREAKOUT: "пробій", REVERSAL: "розворот", HIGH_VOLATILITY: "висока волатильність", LOW_VOLATILITY: "низька волатильність", CHOPPY: "шумний", RANGING: "боковий", EXPANSION: "розширення", COMPRESSION: "стиснення", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}

function marketBlockReasons(signal: Signal) {
  const out: string[] = [];
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) out.push("слабкий обсяг");
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) < 65) out.push("немає ретесту");
  if (signal.entryStatus !== "ENTER_NOW") out.push("очікування підтвердження");
  if (signal.fakeBreakout.risk || signal.marketRegime === "MANIPULATION_RISK") out.push("ризик fake breakout");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") out.push("BTC не підтверджує напрямок");
  return out.length ? out.slice(0, 5) : ["умови формуються", "чекаємо кращу точку входу"];
}
