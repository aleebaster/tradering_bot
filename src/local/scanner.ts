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
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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
      const symbol = this.symbols[this.cursor % this.symbols.length];
      const mode = Math.floor(this.cursor / this.symbols.length) % 2 === 0 ? "futures" : "spot";
      this.cursor += 1;
      const candles = symbol === "BTCUSDT" && mode === "futures" ? btcCandles : await this.loadCandles(symbol, mode);
      const snapshot = await this.snapshot(symbol, mode, candles, btcOk);
      const signal = buildSignal(snapshot);
      logger.info({ symbol, mode, side: signal.side, score: signal.score, winProbability: signal.winProbability, rejectionReason: signal.rejectionReason, scoreBreakdown: signal.scoreBreakdown }, "рішення сканера");
      recordSignal(signal);
      candidates.push(signal);
      if (!this.sent.has(signalKey(signal)) && !["NO_TRADE", "WATCHLIST"].includes(signal.side)) {
        this.sent.add(signalKey(signal));
        await this.notifier.signal(signal).catch((err) => logger.warn({ err }, "Не вдалося надіслати сигнал Telegram"));
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
      state.diagnostics.apiStatus.bybit = "символи перевірено";
      logger.info({ validSymbols: this.symbols, invalidSymbols: invalid }, "Bybit symbol validation completed");
    } catch (err) {
      this.symbols = config.symbols;
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
      entries.push([tf, await this.client.bybitKlines(symbol, tf, category)] as const);
      await sleep(150);
    }
    state.diagnostics.apiStatus.bybit = "підключено";
    return Object.fromEntries(entries);
  }

  private async snapshot(symbol: string, mode: "spot" | "futures", candles: Record<string, Candle[]>, btcOk: boolean): Promise<MarketSnapshot> {
    const tfs = mode === "futures" ? config.futuresTimeframes : config.spotTimeframes;
    const [okxEntries, kucoinEntries, krakenEntries, binanceEntries, imbalance, funding, oi] = await Promise.all([
      Promise.all(tfs.map(async (tf) => [tf, await this.client.okxKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.kucoinKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.krakenSpotKlines(symbol, tf).catch(() => [])] as const)),
      Promise.all(tfs.map(async (tf) => [tf, await this.client.binanceKlines(symbol, tf).catch(() => [])] as const)),
      mode === "futures" ? this.client.orderBookImbalance(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.fundingRate(symbol).catch(() => 0) : Promise.resolve(0),
      mode === "futures" ? this.client.openInterestChange(symbol).catch(() => 0) : Promise.resolve(0)
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
      confirmations: exchangeConfirmations(candles, Object.fromEntries(okxEntries), Object.fromEntries(kucoinEntries), Object.fromEntries(krakenEntries), Object.fromEntries(binanceEntries), mode)
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
      await this.notifier.tradeManagementAlert(signal, action.label, current, action.reasons).catch((err) => logger.warn({ err }, "Не вдалося надіслати Telegram-сповіщення управління угодою"));
    }
  }
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

function tradeManagementAction(signal: Signal, current: number, btcOk: boolean) {
  const long = signal.side === "LONG" || signal.side === "BUY";
  const short = signal.side === "SHORT";
  if (!long && !short) return null;
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  const entered = signal.entryStatus === "ENTER_NOW" || (current >= entryLow && current <= entryHigh);
  if (!entered) return { label: "⏳ ЧЕКАТИ ЗОНУ ВХОДУ", reasons: [`Поточна ціна ${formatPrice(current)} поза зоною входу ${formatPrice(entryLow)}-${formatPrice(entryHigh)}`] };
  if ((long && current <= signal.stopLoss) || (short && current >= signal.stopLoss)) return { label: "🔴 ВИЙТИ З УГОДИ ЗАРАЗ", reasons: ["Досягнуто стоп-лосс або рівень інвалідації", "Спрацювало правило збереження капіталу"] };
  if (!btcOk && signal.symbol !== "BTCUSDT") return { label: "⚠️ ВИЯВЛЕНО РОЗВОРОТ ТРЕНДУ", reasons: ["Виявлено нестабільність BTC", "Ризик позиції по альткоїну зріс"] };
  if ((long && current >= signal.takeProfit[2]) || (short && current <= signal.takeProfit[2])) return { label: "🔴 ВИЙТИ З УГОДИ ЗАРАЗ", reasons: ["Досягнуто TP3", "Запланований прибуток повністю зафіксовано"] };
  if ((long && current >= signal.takeProfit[1]) || (short && current <= signal.takeProfit[1])) return { label: "🟠 АКТИВОВАНО ТРЕЙЛІНГ-СТОП", reasons: ["Досягнуто TP2", "Залишок позиції вести по ATR-структурі"] };
  if ((long && current >= signal.takeProfit[0]) || (short && current <= signal.takeProfit[0])) return { label: "🟠 ЗАФІКСУВАТИ ЧАСТИНУ ПРИБУТКУ", reasons: ["Досягнуто TP1", "Перенести stop loss у беззбиток"] };
  return { label: "🟡 ТРИМАТИ ПОЗИЦІЮ", reasons: ["Вхід активний", "Умов для виходу немає"] };
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
  if (risk) return "⚠️ РИНОК ВИСОКОГО РИЗИКУ — НЕ ВХОДИТИ";
  const best = signals.sort((a, b) => b.score - a.score)[0];
  return best ? `Режим ринку: ${regimeUa(best.marketRegime)}. Найсильніший сетап: ${best.symbol} ${sideUa(best.side)} ${best.score}/100` : "Якісних ринкових даних ще немає";
}

function sideUa(side: Signal["side"]) {
  return side === "NO_TRADE" ? "НЕ ВХОДИТИ" : side === "WATCHLIST" ? "СПОСТЕРЕЖЕННЯ" : side;
}

function regimeUa(regime: Signal["marketRegime"]) {
  const map: Record<Signal["marketRegime"], string> = { TRENDING: "трендовий", RANGING: "боковий", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" };
  return map[regime];
}
