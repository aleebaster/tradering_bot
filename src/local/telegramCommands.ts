import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { state } from "./state";
import { formatDecisionSignal, formatExecutionSignal, signalQuickActions, TelegramNotifier, type TelegramReplyMarkup } from "./telegram";
import { paperMemoryStatsText, paperStatsText, setPaperMode } from "./paperTrading";
import { addPriorityPair, loadPriorityWatchlist, normalizePriorityPair, removePriorityPair } from "./watchlistStore";
import { loadTelegramSettings, updateTelegramSettings, type MaxLeverage, type RiskMode } from "./telegramSettings";
import { performanceText, tradeStatsText } from "./tradeMemory";
import { learningStatusText, resetLearning } from "./learning";
import { analyzeBybitNewToken, formatNewTokenCard, formatNewTokenWatch, scanBybitNewTokens } from "./newTokenScanner";
import { logger } from "./logger";
import { marketThresholdProfile } from "./scoring";
import { marketHealth, resolvePair, type MarketRegistryItem } from "./marketRegistry";
import { analyzeSpot } from "./spotAnalysis";
import { analyzeFutures } from "./marketAnalysis";
import { ExchangeClient } from "./exchanges";
import { formatMomentumAlert, formatMomentumList, momentumActionsKeyboard, MomentumScanner, type MomentumFilter, type MomentumMove } from "./momentumScanner";
import type { Signal } from "./types";
import type { Candle } from "./types";

type PendingAction = "signal" | "watch" | "unwatch" | "balance" | "newsignal" | "search" | "whale_check" | "momentum_check";
type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number | string } } };
};

export interface TelegramCommandHandler {
  send(text: string, replyMarkup?: TelegramReplyMarkup): Promise<void>;
}

export class TelegramCommandCenter {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
  private notifier: TelegramCommandHandler;
  private offset = 0;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  private lockAcquired = false;
  private pendingAction: PendingAction | null = null;
  private startedAt: string | null = null;
  private lastPollAt: string | null = null;
  private lastUpdateAt: string | null = null;
  private lastPollingError: string | null = null;
  private processedUpdates = 0;
  private handledCallbacks = 0;
  private handledMessages = 0;
  private offsetInitialized = false;
  private whaleClient = new ExchangeClient();
  private momentumScanner = new MomentumScanner();

  constructor(notifier: TelegramCommandHandler = new TelegramNotifier()) {
    this.notifier = notifier;
  }

  async start() {
    if (!this.enabled) return;
    if (this.timer) {
      logger.info(this.status(), "Telegram command center already running");
      return;
    }
    this.startedAt = new Date().toISOString();
    logger.info("Telegram command center started");
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 2500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.timer = null;
    this.lockTimer = null;
    this.releasePollingLock();
    logger.info(this.status(), "Telegram command center stopped");
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.timer),
      polling: this.polling,
      offset: this.offset,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      lastUpdateAt: this.lastUpdateAt,
      processedUpdates: this.processedUpdates,
      handledCallbacks: this.handledCallbacks,
      handledMessages: this.handledMessages,
      pendingAction: this.pendingAction,
      lastPollingError: this.lastPollingError,
      lockAcquired: this.lockAcquired,
      offsetInitialized: this.offsetInitialized,
      lock: readPollingLock()
    };
  }

  private acquirePollingLock() {
    const now = Date.now();
    const current = readPollingLock();
    if (current && current.pid !== process.pid && isProcessAlive(current.pid) && now - current.updatedAt < 20_000) {
      this.lastPollingError = `Polling already owned by pid ${current.pid}`;
      logger.warn({ lock: current }, "Telegram polling lock is active; skipping duplicate listener");
      return false;
    }
    if (current && current.pid !== process.pid) logger.warn({ lock: current }, "Telegram polling lock is stale; taking over");
    writePollingLock();
    this.lockAcquired = true;
    this.lockTimer = setInterval(writePollingLock, 5_000);
    return true;
  }

  private releasePollingLock() {
    if (!this.lockAcquired) return;
    const current = readPollingLock();
    if (current?.pid === process.pid) rmSync(telegramLockPath(), { force: true });
    this.lockAcquired = false;
  }

  private async poll() {
    if (this.polling || !config.TELEGRAM_BOT_TOKEN) return;
    if (!this.lockAcquired && !this.acquirePollingLock()) return;
    this.polling = true;
    this.lastPollAt = new Date().toISOString();
    try {
      if (!this.offsetInitialized) await this.resetPollingOffset();
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=1&offset=${this.offset}`;
      const res = await telegramFetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.lastPollingError = `${res.status} ${body}`.slice(0, 300);
        logger.warn({ status: res.status, body }, "Telegram getUpdates failed");
        return;
      }
      const json = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
      this.lastPollingError = null;
      const updates = json.result ?? [];
      if (updates.length) logger.info({ count: updates.length, offset: this.offset }, "Telegram updates received");
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        this.processedUpdates += 1;
        this.lastUpdateAt = new Date().toISOString();
        if (update.callback_query) {
          const chatId = String(update.callback_query.message?.chat?.id ?? "");
          if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
          this.handledCallbacks += 1;
          logger.info({ data: update.callback_query.data }, "Telegram callback received");
          await this.handleCallback(update.callback_query.id, update.callback_query.data ?? "");
          continue;
        }
        const chatId = String(update.message?.chat?.id ?? "");
        if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
        const text = update.message?.text?.trim();
        if (text) {
          this.handledMessages += 1;
          logger.info({ text }, "Telegram message received");
          await this.handle(text);
        }
      }
    } catch (err) {
      this.lastPollingError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "Telegram polling error");
    } finally {
      this.polling = false;
    }
  }

  async handleForTest(text: string): Promise<void> {
    return this.handle(text);
  }

  async handleCallbackForTest(data: string): Promise<void> {
    return this.handleCallback("test", data, false);
  }

  private async resetPollingOffset() {
    if (!config.TELEGRAM_BOT_TOKEN) return;
    try {
      await telegramFetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/deleteWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false })
      }).catch((error) => logger.warn({ err: error }, "Telegram deleteWebhook timed out; continuing with polling"));
      this.offset = 0;
      this.offsetInitialized = true;
      logger.info({ offset: this.offset }, "Telegram polling initialized without discarding pending updates");
    } catch (err) {
      logger.warn({ err }, "Telegram polling offset initialization failed");
    }
  }

  private async handle(text: string): Promise<void> {
    const cleanText = normalizeButtonText(text);
    const button = buttonAction(cleanText);
    if (this.pendingAction && !cleanText.startsWith("/") && (!button || isPairQueryText(cleanText))) {
      logger.info({ text, cleanText, pendingAction: this.pendingAction }, "Telegram handler executed");
      return this.handlePendingInput(cleanText);
    }
    if (this.pendingAction && button) this.pendingAction = null;
    const [rawCommand, rawPair] = cleanText.split(/\s+/, 2);
    const command = rawCommand.split("@")[0].toLowerCase();
    const pair = rawPair ? normalizePriorityPair(rawPair) : "";
    logger.info({ text, cleanText, button, command }, "Telegram handler executed");

    if (command === "/momentum" || command === "/moves") return this.sendMomentum("all");
    if (command === "/scalp" || command === "/scalps") return this.sendMomentum("scalp");
    if (command === "/scalplong") return this.sendMomentum("scalp_long");
    if (command === "/scalpshort") return this.sendMomentum("scalp_short");
    if (command === "/longmovers") return this.sendMomentum("long");
    if (command === "/shortmovers") return this.sendMomentum("short");

    if (["/start", "/menu"].includes(command) || button === "menu" || button === "back") return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (button === "signals") return this.sendTopSetups();
    if (button === "search_pair") return this.askPair("search");
    if (button === "watchlist") return this.notifier.send(watchlistText(), watchlistActionsKeyboard());
    if (button === "settings") return this.notifier.send(settingsText(), settingsKeyboard());
    if (button === "signal_pair") return this.askPair("signal");
    if (button === "watch_add") return this.askPair("watch");
    if (button === "watch_remove") return this.askPair("unwatch");
    if (button === "top" || button === "signals_refresh") return this.sendTopSetups();
    if (button === "positions") return this.askPair("search");
    if (button === "stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (button === "new_tokens") return this.sendNewTokens();
    if (button === "watch_status") return this.notifier.send(watchStatusText(), watchlistActionsKeyboard());
    if (button === "monitoring") return this.sendMonitoring();
    if (button === "momentum") return this.sendMomentum("all");
    if (button === "momentum_scalp") return this.sendMomentum("scalp");
    if (button === "momentum_scalp_long") return this.sendMomentum("scalp_long");
    if (button === "momentum_scalp_short") return this.sendMomentum("scalp_short");
    if (button === "momentum_long") return this.sendMomentum("long");
    if (button === "momentum_short") return this.sendMomentum("short");
    if (button === "momentum_strongest") return this.sendMomentum("strongest");
    if (button === "momentum_check") return this.askPair("momentum_check");
    if (button === "whales") return this.sendWhaleScanner("all");
    if (button === "whales_accumulation") return this.sendWhaleScanner("accumulation");
    if (button === "whales_distribution") return this.sendWhaleScanner("distribution");
    if (button === "whales_strongest") return this.sendWhaleScanner("strongest");
    if (button === "whales_check") return this.askPair("whale_check");
    if (button === "intelligence") return this.notifier.send(intelligenceText("overview"), intelligenceKeyboard());
    if (button === "pump_detector") return this.notifier.send(intelligenceText("pump"), intelligenceKeyboard());
    if (button === "whale_bias") return this.notifier.send(intelligenceText("whale"), intelligenceKeyboard());
    if (button === "liquidation_status") return this.notifier.send(intelligenceText("liq"), intelligenceKeyboard());
    if (button === "market_regime") return this.notifier.send(intelligenceText("market"), intelligenceKeyboard());
    if (button === "market") return this.notifier.send(marketText(), marketActionsKeyboard());
    if (button === "btc") return this.notifier.send(btcText(), marketActionsKeyboard());
    if (button === "diagnostics") return this.notifier.send(diagnosticsText(), diagnosticsActionsKeyboard());
    if (button === "balance") return this.askPair("balance");
    if (button === "leverage") return this.notifier.send(leverageText(), leverageKeyboard());
    if (button === "x2" || button === "x3") return this.setLeverage(button);
    if (button === "notifications") return this.toggleNotifications();
    if (button === "telegram_ux") return this.notifier.send(settingsDetailText(cleanText), settingsKeyboard());
    if (button === "risk_mode") return this.notifier.send(riskModeText(), riskModeKeyboard());
    if (button === "conservative" || button === "balanced" || button === "aggressive") return this.setRiskMode(riskModeFromButton(button));

    if (command === "/help") return this.notifier.send(helpText(), mainMenuKeyboard());
    if (command === "/status") return this.notifier.send(statusText(), mainMenuKeyboard());
    if (command === "/okxdebug") return this.sendOkxDebug();
    if (command === "/signals") return this.sendTopSetups();
    if (command === "/diagnostics") return this.notifier.send(diagnosticsText(), diagnosticsActionsKeyboard());
    if (command === "/market") return this.notifier.send(marketText(), marketActionsKeyboard());
    if (command === "/whales") return this.sendWhaleScanner("all");
    if (command === "/intelligence") return this.notifier.send(intelligenceText("overview"), intelligenceKeyboard());
    if (command === "/markethealth") return this.notifier.send(marketHealthText(), marketActionsKeyboard());
    if (command === "/btc") return this.notifier.send(btcText(), marketActionsKeyboard());
    if (command === "/positions") return this.askPair("search");
    if (command === "/stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (command === "/settings") return this.notifier.send(settingsText(), settingsKeyboard());
    if (command === "/performance") return this.notifier.send(performanceText(), mainMenuKeyboard());
    if (command === "/learning") return this.notifier.send(learningStatusText(), mainMenuKeyboard());
    if (command === "/resetlearning") return this.resetLearningCommand();
    if (command === "/top") return this.sendTopSetups();
    if (command === "/search") {
      if (!rawPair) return this.askPair("search");
      return this.sendPairSearch(rawPair);
    }
    if (command === "/watchlist") return this.notifier.send(watchlistText(), watchlistActionsKeyboard());
    if (command === "/watchstatus") return this.notifier.send(watchStatusText(), watchlistActionsKeyboard());
    if (command === "/paper") {
      const action = rawPair?.toLowerCase();
      if (action === "on") return this.notifier.send(paperModeText(true));
      if (action === "off") return this.notifier.send(paperModeText(false));
      return this.notifier.send(paperStatsText(), settingsKeyboard());
    }
    if (command === "/paperstats") return this.notifier.send(paperMemoryStatsText(), mainMenuKeyboard());
    if (command === "/newtokens" || command === "/newwatch") return this.sendNewTokens();
    if (command === "/newsignal") {
      if (!pair) return this.askPair("newsignal");
      return this.sendNewSignal(pair);
    }

    if (command === "/watch") {
      if (!pair) return this.askPair("watch");
      addPriorityPair(pair);
      await this.notifier.send(watchAddedText(pair), watchlistQuickKeyboard(pair));
      return this.notifier.send(monitoringStatusFor(pair), signalQuickActions(pair));
    }

    if (command === "/unwatch") {
      if (!pair) return this.askPair("unwatch");
      const pairs = removePriorityPair(pair);
      return this.notifier.send(["✅ Видалено з моніторингу", "", pair, "", pairs.length ? `Активний список моніторингу: ${pairs.join(", ")}` : "Список моніторингу порожній"].join("\n"), watchlistMenuKeyboard());
    }

    if (command === "/signal") {
      if (!pair) return this.askPair("signal");
      await this.notifier.send(`⏳ Аналізую ${pair}...`, signalActionsKeyboard());
      addPriorityPair(pair);
      startOneShotAnalysis(pair);
      return this.notifier.send(signalAnalysisText(pair), signalQuickActions(pair));
    }

    logger.warn({ text, cleanText }, "Unhandled Telegram button text");
    return this.notifier.send("Невідома дія. Натисни 📋 Меню", mainMenuKeyboard());
  }

  private async askPair(action: PendingAction): Promise<void> {
    this.pendingAction = action;
    if (action === "balance") return this.notifier.send(["💰 Баланс", "", `Поточний баланс: ${loadTelegramSettings().balanceUsdt} USDT`, "", "Введіть новий баланс у USDT:", "Наприклад: 5"].join("\n"), backKeyboard());
    if (action === "whale_check") return this.notifier.send(["🐋 Перевірити монету", "", "Введіть монету або пару:", "BTC", "ETH", "PEPE", "DOGE", "BTCUSDT", "", "Я нормалізую btc → BTCUSDT."].join("\n"), whaleActionsKeyboard());
    if (action === "momentum_check") return this.notifier.send(["🚨 Перевірити великий рух", "", "Введіть монету або пару:", "ESPORTS", "BTC", "ETH", "PEPE", "DOGE", "", "Я нормалізую btc → BTCUSDT."].join("\n"), momentumActionsKeyboard());
    const title = action === "search" ? "пошуку" : action === "newsignal" ? "new-token аналізу" : action === "signal" ? "аналізу" : action === "watch" ? "додавання" : "видалення";
    const question = action === "unwatch" ? "Яку пару видалити?" : "Введіть пару:";
    return this.notifier.send([question, "", "Приклади:", "BTCUSDT", "ETHUSDT", "AIGENSYNUSDT", "PEPEUSDT", "", "Можна вводити lowercase/uppercase: btc, BTC, btcusdt", "Пошук іде по всіх Bybit Spot/Futures/Perpetual/USDT/new listings.", "", `Режим: ${title}`].join("\n"), backKeyboard());
  }

  private async handlePendingInput(text: string): Promise<void> {
    const action = this.pendingAction;
    this.pendingAction = null;
    if (action === "balance") return this.setBalance(text);
    if (action === "search") return this.sendPairSearch(text);
    if (action === "whale_check") return this.sendWhaleCoin(text);
    if (action === "momentum_check") return this.sendMomentumCoin(text);
    const pair = normalizePriorityPair(text);
    if (!pair || pair.length < 6) return this.notifier.send("Пара не розпізнана. Приклад: BTCUSDT", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "unwatch") return this.handle(`/unwatch ${pair}`);
    if (action === "newsignal") return this.handle(`/newsignal ${pair}`);
    return this.handle(`/signal ${pair}`);
  }

  private async sendNewTokens(): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send("🚀 НОВІ МОНЕТИ\n\nТестовий режим: Bybit scan пропущено.", signalActionsKeyboard());
    const items = await scanBybitNewTokens(5).catch((error) => {
      logger.warn({ err: error }, "Bybit new token scan failed");
      return [];
    });
    return this.notifier.send(formatNewTokenWatch(items), signalActionsKeyboard());
  }

  private async sendNewSignal(pair: string): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(`🚀 АНАЛІЗ НОВОЇ МОНЕТИ\n\n${pair}\n\nТестовий режим: Bybit scan пропущено.`, signalQuickActions(pair));
    const item = await analyzeBybitNewToken(pair).catch((error) => ({
      symbol: pair,
      status: "REJECTED" as const,
      side: "WAIT" as const,
      score: 0,
      listedDays: null,
      turnover24h: 0,
      spreadPct: 1,
      depthUsdt: 0,
      confirmations: 0,
      btcStable: false,
      entryStatus: "NO_TRADE" as const,
      entry: [0, 0] as [number, number],
      stopLoss: 0,
      takeProfit: [0, 0, 0] as [number, number, number],
      leverage: "x2" as const,
      reasons: ["Bybit Futures only"],
      waitingFor: ["quality liquidity", "BTC stable", "retest", "sniper trigger"],
      rejectionReason: error instanceof Error ? error.message : String(error),
      earlyMomentum: false
    }));
    return this.notifier.send(formatNewTokenCard(item), signalQuickActions(pair));
  }

  private async setBalance(text: string): Promise<void> {
    const balance = Number(text.replace(",", "."));
    if (!Number.isFinite(balance) || balance <= 0) return this.notifier.send("Баланс не розпізнано. Приклад: 5", settingsKeyboard());
    const settings = updateTelegramSettings({ balanceUsdt: Math.round(balance * 100) / 100 });
    return this.notifier.send(["✅ Баланс оновлено", "", `Поточний баланс: ${settings.balanceUsdt} USDT`].join("\n"), settingsKeyboard());
  }

  private async sendTopSetups(): Promise<void> {
    const top = topSignals();
    if (!top.length) return this.notifier.send(["📊 Сигнали / 🔥 Топ Сетапи", "", "Активних entry/watchlist setup зараз немає.", "", marketText()].join("\n"), signalActionsKeyboard());
    await this.notifier.send(["📊 Сигнали / 🔥 Топ Сетапи", "", ...top.map(compactSignalCard)].join("\n\n"), signalActionsKeyboard());
  }

  private async sendWhaleScanner(filter: WhaleFilter): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(formatWhaleScanner(sampleWhaleRows(), filter), whaleActionsKeyboard());
    await this.notifier.send("⏳ Сканую рух китів: Futures + Spot...", whaleActionsKeyboard());
    const rows = await scanWhaleFlow(this.whaleClient, filter).catch((error) => {
      logger.warn({ err: error, filter }, "Whale flow scan failed");
      return [] as WhaleRow[];
    });
    return this.notifier.send(formatWhaleScanner(rows, filter), whaleActionsKeyboard());
  }

  private async sendMomentum(filter: MomentumFilter): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(formatMomentumList(sampleMomentumRows(), momentumTitle(filter)), momentumActionsKeyboard());
    await this.notifier.send("⏳ Сканую сильні рухи: Bybit Futures + Spot, обсяг/OI/кити/BTC фільтри...", momentumActionsKeyboard());
    const rows = await this.momentumScanner.scan(filter).catch((error) => {
      logger.warn({ err: error, filter }, "Momentum scanner failed");
      return [];
    });
    return this.notifier.send(formatMomentumList(rows, momentumTitle(filter)), momentumActionsKeyboard());
  }

  private async sendMomentumCoin(input: string): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(formatMomentumAlert(sampleMomentumRows()[0]), momentumActionsKeyboard());
    await this.notifier.send(`⏳ Перевіряю сильний рух ${input.toUpperCase()}...`, momentumActionsKeyboard());
    const row = await this.momentumScanner.checkSymbol(input).catch((error) => {
      logger.warn({ err: error, input }, "Momentum coin check failed");
      return null;
    });
    if (!row) return this.notifier.send(["🚨 Сканер сильних рухів", "", input.toUpperCase(), "", "Чистий імпульсний тригер зараз не підтверджений.", "Фільтр відсікає fake pump, низьку ліквідність, слабкий обсяг/OI або конфлікт із BTC."].join("\n"), momentumActionsKeyboard());
    return this.notifier.send(formatMomentumAlert(row), momentumActionsKeyboard());
  }

  private async sendWhaleCoin(input: string): Promise<void> {
    const pair = normalizeWhalePair(input);
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(formatWhaleCoin(sampleWhaleRows()[0]), whaleActionsKeyboard());
    await this.notifier.send(`⏳ Перевіряю ${pair}: Futures + Spot...`, whaleActionsKeyboard());
    const row = await analyzeWhaleSymbol(this.whaleClient, pair).catch((error) => {
      logger.warn({ err: error, pair }, "Whale coin check failed");
      return null;
    });
    if (!row) return this.notifier.send([`🐋 ${pair}`, "", "Не вдалося отримати live Bybit Futures + Spot дані для цієї монети.", "Спробуй ще раз або перевір іншу пару."].join("\n"), whaleActionsKeyboard());
    return this.notifier.send(formatWhaleCoin(row), whaleActionsKeyboard());
  }

  private async sendPositions(): Promise<void> {
    if (!state.activeSignals.length) return this.askPair("search");
    await this.notifier.send("🔍 Пошук по парах\n\nВведи пару для професійного аналізу, наприклад BTCUSDT або btc.", positionsActionsKeyboard());
    for (const signal of state.activeSignals.slice(0, 8)) await this.notifier.send(positionSummary(signal), signalQuickActions(signal.symbol));
  }

  private async sendMonitoring(): Promise<void> {
    const pairs = loadPriorityWatchlist();
    if (!pairs.length) return this.notifier.send("👀 Моніторинг\n\nСписок моніторингу порожній. Натисни ➕ Додати пару.", watchlistActionsKeyboard());
      await this.notifier.send("👀 Моніторинг активний\n\n⏱ Еволюція сетапів: перевірка кожні 2 хв", watchlistActionsKeyboard());
    for (const pair of pairs.slice(0, 10)) await this.notifier.send(monitoringStatusFor(pair), signalQuickActions(pair));
  }

  private async setLeverage(value: MaxLeverage): Promise<void> {
    const settings = updateTelegramSettings({ maxLeverage: value });
    return this.notifier.send(["✅ Максимальне плече оновлено", "", `Поточний ліміт: ${settings.maxLeverage}`, "Для малого рахунку сигнал використовує x2; x3 тільки для A+ setup."].join("\n"), settingsKeyboard());
  }

  private async toggleNotifications(): Promise<void> {
    const current = loadTelegramSettings();
    const settings = updateTelegramSettings({ notifications: !current.notifications });
    return this.notifier.send(["🔔 Сповіщення", "", `Статус: ${settings.notifications ? "ON" : "OFF"}`, "Командні відповіді залишаються активними."].join("\n"), settingsKeyboard());
  }

  private async setRiskMode(value: RiskMode): Promise<void> {
    const settings = updateTelegramSettings({ riskMode: value });
    return this.notifier.send(["✅ Режим ризику оновлено", "", `Поточний режим: ${riskModeUa(settings.riskMode)}`].join("\n"), settingsKeyboard());
  }

  private async resetLearningCommand(): Promise<void> {
    resetLearning();
    return this.notifier.send(["✅ Навчання скинуто", "", "Адаптивні ваги повернено до стандартних.", "Безпечне навчання перезапуститься після 20 завершених угод."].join("\n"), mainMenuKeyboard());
  }

  private async handleCallback(id: string, data: string, answer = true): Promise<void> {
    if (answer) await answerCallback(id);
    const [action, rawSymbol] = data.split(":", 2);
    logger.info({ data, action, rawSymbol }, "Telegram callback handler executed");
    if (action === "ui") return this.handleUiCallback(rawSymbol ?? "");
    if (!rawSymbol && buttonAction(action)) return this.handleUiCallback(action);
    const pair = normalizePriorityPair(rawSymbol ?? "");
    if (!pair) return this.notifier.send("Пара не розпізнана", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "refresh") return this.handle(`/signal ${pair}`);
    if (action === "analyze_futures") return this.sendFuturesAnalysis(pair);
    if (action === "analyze_spot") return this.sendSpotAnalysis(pair);
    if (action === "raw_futures") return this.sendRawFuturesAnalysis(pair);
    if (action === "raw_spot") return this.sendRawSpotAnalysis(pair);
    if (action === "search_add") return this.handle(`/watch ${pair}`);
    if (action === "remove") return this.handle(`/unwatch ${pair}`);
    if (action === "full") return this.notifier.send(fullAnalysisText(pair), signalQuickActions(pair));
  }

  private async handleUiCallback(action: string): Promise<void> {
    if (action === "momentum") return this.sendMomentum("all");
    if (action === "momentum_scalp") return this.sendMomentum("scalp");
    if (action === "momentum_scalp_long") return this.sendMomentum("scalp_long");
    if (action === "momentum_scalp_short") return this.sendMomentum("scalp_short");
    if (action === "momentum_long") return this.sendMomentum("long");
    if (action === "momentum_short") return this.sendMomentum("short");
    if (action === "momentum_strongest") return this.sendMomentum("strongest");
    if (action === "momentum_check") return this.askPair("momentum_check");
    const button = buttonAction(action);
    if (!button) return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (this.pendingAction) this.pendingAction = null;
    if (button === "menu" || button === "back") return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (button === "signals") return this.sendTopSetups();
    if (button === "search_pair") return this.askPair("search");
    if (button === "watchlist") return this.notifier.send(watchlistText(), watchlistActionsKeyboard());
    if (button === "settings") return this.notifier.send(settingsText(), settingsKeyboard());
    if (button === "signal_pair") return this.askPair("signal");
    if (button === "watch_add") return this.askPair("watch");
    if (button === "watch_remove") return this.askPair("unwatch");
    if (button === "top" || button === "signals_refresh") return this.sendTopSetups();
    if (button === "positions") return this.askPair("search");
    if (button === "stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (button === "new_tokens") return this.sendNewTokens();
    if (button === "watch_status") return this.notifier.send(watchStatusText(), watchlistActionsKeyboard());
    if (button === "monitoring") return this.sendMonitoring();
    if (button === "momentum") return this.sendMomentum("all");
    if (button === "momentum_scalp") return this.sendMomentum("scalp");
    if (button === "momentum_scalp_long") return this.sendMomentum("scalp_long");
    if (button === "momentum_scalp_short") return this.sendMomentum("scalp_short");
    if (button === "momentum_long") return this.sendMomentum("long");
    if (button === "momentum_short") return this.sendMomentum("short");
    if (button === "momentum_strongest") return this.sendMomentum("strongest");
    if (button === "momentum_check") return this.askPair("momentum_check");
    if (button === "whales") return this.sendWhaleScanner("all");
    if (button === "whales_accumulation") return this.sendWhaleScanner("accumulation");
    if (button === "whales_distribution") return this.sendWhaleScanner("distribution");
    if (button === "whales_strongest") return this.sendWhaleScanner("strongest");
    if (button === "whales_check") return this.askPair("whale_check");
    if (button === "intelligence") return this.notifier.send(intelligenceText("overview"), intelligenceKeyboard());
    if (button === "pump_detector") return this.notifier.send(intelligenceText("pump"), intelligenceKeyboard());
    if (button === "whale_bias") return this.notifier.send(intelligenceText("whale"), intelligenceKeyboard());
    if (button === "liquidation_status") return this.notifier.send(intelligenceText("liq"), intelligenceKeyboard());
    if (button === "market_regime") return this.notifier.send(intelligenceText("market"), intelligenceKeyboard());
    if (button === "market") return this.notifier.send(marketText(), marketActionsKeyboard());
    if (button === "btc") return this.notifier.send(btcText(), marketActionsKeyboard());
    if (button === "diagnostics") return this.notifier.send(diagnosticsText(), diagnosticsActionsKeyboard());
    if (button === "balance") return this.askPair("balance");
    if (button === "leverage") return this.notifier.send(leverageText(), leverageKeyboard());
    if (button === "x2" || button === "x3") return this.setLeverage(button);
    if (button === "notifications") return this.toggleNotifications();
    if (button === "telegram_ux") return this.notifier.send(settingsDetailText(action), settingsKeyboard());
    if (button === "risk_mode") return this.notifier.send(riskModeText(), riskModeKeyboard());
    if (button === "conservative" || button === "balanced" || button === "aggressive") return this.setRiskMode(riskModeFromButton(button));
  }

  private async sendPairSearch(query: string): Promise<void> {
    const result = await resolvePair(query).catch((error) => {
      logger.warn({ err: error, query }, "Pair search failed");
      return null;
    });
    if (!result || !result.best) return this.notifier.send(pairNotFoundText(query, result?.suggestions ?? []), mainMenuKeyboard());
    if (result.futures.length) {
      const signal = await analyzeFutures(result.best.symbol).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      if (!("error" in signal)) return this.notifier.send(futuresExecutionAnalysisText(signal, result.futures[0], result), pairSearchKeyboard(signal.symbol, true, Boolean(result.spot.length)));
      logger.warn({ err: signal.error, query }, "Futures pair analysis failed");
    }
    const spot = await analyzeSpot(result.spot[0]?.symbol ?? result.best.symbol).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in spot) return this.notifier.send(`Пару знайдено, але аналіз зараз недоступний: ${spot.error}`, mainMenuKeyboard());
    return this.notifier.send(spotExecutionAnalysisText(spot), pairSearchKeyboard(spot.symbol, Boolean(result.futures.length), true));
  }

  private async sendSpotAnalysis(pair: string): Promise<void> {
    const analysis = await analyzeSpot(pair).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in analysis) return this.notifier.send(`Spot analysis failed: ${analysis.error}`, mainMenuKeyboard());
    return this.notifier.send(spotTraderBriefText(analysis), pairSearchKeyboard(analysis.symbol, false, true));
  }

  private async sendFuturesAnalysis(pair: string): Promise<void> {
    const signal = await analyzeFutures(pair).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in signal) return this.notifier.send(`Futures analysis failed: ${signal.error}`, mainMenuKeyboard());
    return this.notifier.send(futuresTraderBriefText(signal), pairSearchKeyboard(signal.symbol, true, false));
  }

  private async sendRawSpotAnalysis(pair: string): Promise<void> {
    const analysis = await analyzeSpot(pair).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in analysis) return this.notifier.send(`Spot raw analysis failed: ${analysis.error}`, mainMenuKeyboard());
    return this.notifier.send(spotProfessionalAnalysisText(analysis, undefined, undefined), pairSearchKeyboard(analysis.symbol, false, true));
  }

  private async sendRawFuturesAnalysis(pair: string): Promise<void> {
    const signal = await analyzeFutures(pair).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ("error" in signal) return this.notifier.send(`Futures raw analysis failed: ${signal.error}`, mainMenuKeyboard());
    return this.notifier.send(futuresProfessionalAnalysisText(signal, undefined, undefined), pairSearchKeyboard(signal.symbol, true, false));
  }

  private async sendOkxDebug(): Promise<void> {
    const env = okxEnvDebug();
    const auth = await this.whaleClient.okxAuthCheck()
      .then((result) => ({ ok: true, detail: `Account level: ${result.accountLevel ?? "unknown"}; permissions: ${result.permissions ?? "unknown"}` }))
      .catch((error) => ({ ok: false, detail: okxErrorReason(error instanceof Error ? error.message : String(error)) }));
    return this.notifier.send([
      "🧪 OKX DEBUG",
      "",
      `API KEY: ${env.key}`,
      `SECRET: ${env.secret}`,
      `PASSPHRASE: ${env.passphrase}`,
      "",
      `AUTH STATUS: ${auth.ok ? "OK" : "FAIL"}`,
      `ERROR REASON: ${auth.detail}`,
      "",
      auth.ok ? "✅ OKX private endpoints працюють." : "⚠️ Якщо причина Wrong passphrase / 50105: passphrase не відповідає цьому OKX API key. Потрібно створити/вставити правильну пару key+secret+passphrase."
    ].join("\n"), diagnosticsActionsKeyboard());
  }
}

async function answerCallback(callbackQueryId: string) {
  if (!config.TELEGRAM_BOT_TOKEN) return;
  await telegramFetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  }).catch(() => undefined);
}

async function telegramFetch(url: string, init?: RequestInit, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function telegramLockPath() {
  const dir = join(tmpdir(), "tradering-bot");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "telegram-polling.lock.json");
}

function readPollingLock(): { pid: number; updatedAt: number } | null {
  try {
    return JSON.parse(readFileSync(telegramLockPath(), "utf8")) as { pid: number; updatedAt: number };
  } catch {
    return null;
  }
}

function writePollingLock() {
  writeFileSync(telegramLockPath(), JSON.stringify({ pid: process.pid, updatedAt: Date.now() }));
}

function okxEnvDebug() {
  return {
    key: envLoaded(config.OKX_API_KEY),
    secret: envLoaded(config.OKX_API_SECRET),
    passphrase: envLoaded(config.OKX_API_PASSPHRASE)
  };
}

function envLoaded(value?: string) {
  if (!value) return "not loaded";
  const problems = [value !== value.trim() ? "whitespace" : "", /^['"]|['"]$/.test(value) ? "quotes" : "", /[\r\n]/.test(value) ? "newline" : ""].filter(Boolean);
  return problems.length ? `loaded (${problems.join(", ")})` : "loaded";
}

function okxErrorReason(message: string) {
  if (/50105|passphrase/i.test(message)) return "Wrong passphrase / OKX 50105: passphrase не відповідає API key або key створено з іншим passphrase.";
  if (/50113|signature/i.test(message)) return "Signature error: перевірити secret, timestamp і method/path signing.";
  if (/timestamp|50102/i.test(message)) return "Timestamp sync error: системний час або OKX timestamp window.";
  if (/incomplete/i.test(message)) return "Credentials incomplete: відсутній API key, secret або passphrase.";
  return message.slice(0, 220);
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startOneShotAnalysis(pair: string) {
  if (process.env.TELEGRAM_HANDLER_TEST === "1") return;
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/manual-aigensyn-bybit.ts", pair], {
    cwd: process.cwd(),
    env: { ...process.env, PAIR: pair },
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
}

function mainMenuKeyboard(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: "📊 Сигнали" }, { text: "🔎 Пошук по парах" }],
      [{ text: "👀 Список моніторингу" }, { text: "📈 Ринок" }],
      [{ text: "₿ BTC Фільтр" }, { text: "🔥 Топ Сетапи" }],
      [{ text: "🚨 Великі рухи" }, { text: "🐋 Рух китів" }],
      [{ text: "🧠 Інтелект" }, { text: "🪙 Нові монети" }],
      [{ text: "📊 Статистика" }, { text: "⚙️ Налаштування" }],
      [{ text: "🧪 Діагностика" }, { text: "📁 Позиції" }],
      [{ text: "🏠 Головне меню" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function signalMenuKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔍 Аналіз пари", "signal_pair")],
      [uiButton("🪙 Нові монети", "new_tokens")],
      [uiButton("🔥 Найкращі сигнали", "top"), uiButton("🔍 Пошук по парах", "search_pair")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function watchlistMenuKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("➕ Додати пару", "watch_add"), uiButton("📄 Мій список", "watchlist")],
      [uiButton("👀 Статус моніторингу", "watch_status")],
      [uiButton("❌ Видалити пару", "watch_remove"), uiButton("🔴 Моніторинг", "monitoring")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function signalActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Сигнали", "signals_refresh"), uiButton("🔍 Аналіз пари", "signal_pair")],
      [uiButton("🔥 Топ Сетапи", "top"), uiButton("🔍 Пошук по парах", "search_pair")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function marketActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Ринок", "market")],
      [uiButton("📡 Інтелект", "intelligence"), uiButton("Режим ринку", "market_regime")],
      [uiButton("📊 Сигнали", "signals"), uiButton("🔥 Топ Сетапи", "top")],
      [uiButton("₿ BTC Фільтр", "btc"), uiButton("🔙 Назад", "back")]
    ]
  };
}

function watchlistActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("📄 Мій список", "watchlist"), uiButton("👀 Статус моніторингу", "watch_status")],
      [uiButton("🔴 Моніторинг", "monitoring")],
      [uiButton("➕ Додати пару", "watch_add"), uiButton("❌ Видалити пару", "watch_remove")],
      [uiButton("📊 Аналіз", "signal_pair"), uiButton("🔙 Назад", "back")]
    ]
  };
}

function positionsActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔍 Пошук по парах", "search_pair"), uiButton("🔥 Топ Сетапи", "top")],
      [uiButton("📊 Сигнали", "signals"), uiButton("🔙 Назад", "back")]
    ]
  };
}

function diagnosticsActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Статус", "diagnostics")],
      [uiButton("📈 Ринок", "market"), uiButton("📊 Сигнали", "signals")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function whaleActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити скан", "whales")],
      [uiButton("📈 Тільки накопичення", "whales_accumulation"), uiButton("📉 Тільки розподіл", "whales_distribution")],
      [uiButton("🔥 Найсильніші рухи", "whales_strongest"), uiButton("🔍 Перевірити монету", "whales_check")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function watchlistQuickKeyboard(_pair: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("📄 Мій список", "watchlist"), uiButton("👀 Статус моніторингу", "watch_status")],
      [uiButton("❌ Видалити пару", "watch_remove")],
      [uiButton("📊 Аналіз", "signal_pair"), uiButton("🔴 Моніторинг", "monitoring")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function settingsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("💰 Баланс", "balance"), uiButton("⚡ Плече", "leverage")],
      [uiButton("🔔 Сповіщення", "notifications"), uiButton("📱 Telegram UX", "telegram_ux")],
      [uiButton("🎯 Режим ризику", "risk_mode")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function leverageKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("x2", "x2"), uiButton("x3", "x3")], [uiButton("🔙 Назад", "back")]] };
}

function riskModeKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("Обережний", "conservative"), uiButton("Збалансований", "balanced")], [uiButton("Агресивний", "aggressive")], [uiButton("🔙 Назад", "back")]] };
}

function intelligenceKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("Детектор пампу", "pump_detector"), uiButton("Перекіс китів", "whale_bias")],
      [uiButton("Ліквідації", "liquidation_status"), uiButton("Режим ринку", "market_regime")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function backKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("🔙 Назад", "back")]] };
}

function pairSearchKeyboard(symbol: string, hasFutures: boolean, hasSpot: boolean): TelegramReplyMarkup {
  const rows: TelegramReplyMarkup["inline_keyboard"] = [];
  const analysis = [];
  if (hasFutures) analysis.push({ text: "📖 Детальний аналіз", callback_data: `analyze_futures:${symbol}` });
  if (!hasFutures && hasSpot) analysis.push({ text: "📖 Детальний аналіз", callback_data: `analyze_spot:${symbol}` });
  if (hasFutures && hasSpot) analysis.push({ text: "💰 Детальний Spot", callback_data: `analyze_spot:${symbol}` });
  if (analysis.length) rows.push(analysis);
  const raw = [];
  if (hasFutures) raw.push({ text: "🛠 Сирі технічні дані", callback_data: `raw_futures:${symbol}` });
  if (!hasFutures && hasSpot) raw.push({ text: "🛠 Сирі технічні дані", callback_data: `raw_spot:${symbol}` });
  if (hasFutures && hasSpot) raw.push({ text: "🛠 Сирі spot-дані", callback_data: `raw_spot:${symbol}` });
  if (raw.length) rows.push(raw);
  rows.push([{ text: "🔥 Додати в моніторинг", callback_data: `search_add:${symbol}` }]);
  rows.push([uiButton("🔍 Пошук по парах", "search_pair"), uiButton("🔙 Назад", "back")]);
  return { inline_keyboard: rows };
}

function uiButton(text: string, action: string) {
  return { text, callback_data: `ui:${action}` };
}

function mainMenuText() {
  return [
    "📋 Головне меню",
    "",
    "Обери дію кнопками нижче.",
    "Кнопки повертають поточні live-дані. Авто-сповіщення: тільки entry та trade management."
  ].join("\n");
}

function whaleMenuPlaceholderText() {
  return [
    "🐋 Сканер руху китів",
    "",
    "Комбінований аналіз китів Futures + Spot готується.",
    "Натисни 🔄 Оновити скан після завершення індексації ринку."
  ].join("\n");
}

type WhaleFilter = "all" | "accumulation" | "distribution" | "strongest";
type WhaleStatus = "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL" | "CONFLICTED";
type WhaleRow = {
  symbol: string;
  status: WhaleStatus;
  confidence: number;
  score: number;
  futuresBias: number;
  spotBias: number;
  priceChange: number;
  oiChange: number;
  fundingRate: number;
  volumeSpike: number;
  liquidationPressure: "short squeeze" | "long squeeze" | "neutral";
  reasons: string[];
};

async function scanWhaleFlow(client: ExchangeClient, filter: WhaleFilter): Promise<WhaleRow[]> {
  const [linear, spot] = await Promise.all([client.bybitTickers("linear"), client.bybitTickers("spot")]);
  const spotSymbols = new Set(spot.map((item) => item.symbol));
  const preferred = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "PEPEUSDT", "LINKUSDT", "AVAXUSDT", "ADAUSDT", "AIGENSYNUSDT"]);
  const candidates = linear
    .filter((item) => item.symbol.endsWith("USDT") && spotSymbols.has(item.symbol) && item.turnover24h > 0)
    .sort((a, b) => (preferred.has(b.symbol) ? 2_000_000_000 : 0) + b.turnover24h - ((preferred.has(a.symbol) ? 2_000_000_000 : 0) + a.turnover24h))
    .slice(0, 18)
    .map((item) => item.symbol);
  const rows = (await Promise.all(candidates.map((symbol) => analyzeWhaleSymbol(client, symbol).catch((error) => {
    logger.warn({ err: error, symbol }, "Whale flow symbol skipped");
    return null;
  })))).filter((row): row is WhaleRow => Boolean(row));
  const filtered = rows.filter((row) => filter === "all" || filter === "strongest" || filter === "accumulation" && row.status === "ACCUMULATION" || filter === "distribution" && row.status === "DISTRIBUTION");
  return filtered.sort((a, b) => b.score - a.score || b.confidence - a.confidence).slice(0, filter === "strongest" ? 10 : 15);
}

async function analyzeWhaleSymbol(client: ExchangeClient, symbol: string): Promise<WhaleRow> {
  const pair = normalizePriorityPair(symbol);
  const [futuresCandles, spotCandles, linearBook, spotBook, oiChange, fundingRate, accountRatio] = await Promise.all([
    client.bybitKlines(pair, "5", "linear", 36),
    client.bybitKlines(pair, "5", "spot", 36).catch(() => [] as Candle[]),
    client.bybitOrderBookStats(pair, "linear").catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    client.bybitOrderBookStats(pair, "spot").catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    client.openInterestChange(pair).catch(() => 0),
    client.fundingRate(pair).catch(() => 0),
    client.bybitAccountRatio(pair).catch(() => 0)
  ]);
  const priceChange = changeFrom(futuresCandles, 12);
  const spotChange = changeFrom(spotCandles, 12);
  const futuresVolumeSpike = volumeSpikeRatio(futuresCandles);
  const spotVolumeSpike = volumeSpikeRatio(spotCandles);
  const futuresBias = futuresDirection(priceChange, oiChange, linearBook.imbalance, accountRatio);
  const spotBias = spotDirection(spotChange, spotVolumeSpike, spotBook.imbalance);
  const liquidationPressure = squeezePressure(futuresCandles, futuresVolumeSpike, priceChange);
  const fundingPenalty = Math.abs(fundingRate) > 0.0007 ? 8 : Math.abs(fundingRate) > 0.00035 ? 4 : 0;
  const conflicted = futuresBias > 20 && spotBias < -15 || futuresBias < -20 && spotBias > 15;
  const combined = futuresBias * 0.48 + spotBias * 0.42 + Math.sign(futuresBias + spotBias) * Math.min(10, Math.max(futuresVolumeSpike, spotVolumeSpike) * 4) - Math.sign(futuresBias + spotBias) * fundingPenalty;
  const status: WhaleStatus = conflicted ? "CONFLICTED" : combined >= 22 ? "ACCUMULATION" : combined <= -22 ? "DISTRIBUTION" : "NEUTRAL";
  const activityScore = clampNumber(Math.abs(combined) + Math.min(24, Math.abs(oiChange) * 4500) + Math.min(18, Math.max(futuresVolumeSpike, spotVolumeSpike) * 6) + Math.min(14, Math.abs(linearBook.imbalance + spotBook.imbalance) * 40), 0, 100);
  const confidence = status === "NEUTRAL" ? clampNumber(Math.round(activityScore * 0.55), 25, 58) : clampNumber(Math.round(activityScore - (conflicted ? 12 : 0)), 45, 94);
  return {
    symbol: pair,
    status,
    confidence,
    score: Math.round(activityScore),
    futuresBias: Math.round(futuresBias),
    spotBias: Math.round(spotBias),
    priceChange,
    oiChange,
    fundingRate,
    volumeSpike: Math.max(futuresVolumeSpike, spotVolumeSpike),
    liquidationPressure,
    reasons: whaleReasons({ status, priceChange, oiChange, fundingRate, futuresVolumeSpike, spotVolumeSpike, futuresBias, spotBias, liquidationPressure, accountRatio, spotImbalance: spotBook.imbalance })
  };
}

function formatWhaleScanner(rows: WhaleRow[], filter: WhaleFilter) {
  const title = filter === "accumulation" ? "🐋 Сканер руху китів — накопичення" : filter === "distribution" ? "🐋 Сканер руху китів — розподіл" : filter === "strongest" ? "🐋 Сканер руху китів — найсильніші" : "🐋 Сканер руху китів";
  if (!rows.length) return [title, "", "Немає достатньо сильного руху китів зараз.", "Futures + Spot перевірені; чекаємо чистіший дисбаланс."].join("\n");
  return [title, "", ...rows.slice(0, 12).map(formatWhaleRow)].join("\n\n");
}

function formatWhaleCoin(row: WhaleRow) {
  return [
    `🐋 ${row.symbol}`,
    "",
    "Статус:",
    `${whaleStatusLabel(row.status)}`,
    "",
    `Впевненість входу: ${row.confidence}/100`,
    `Оцінка китів: ${row.score}/100`,
    "",
    "Що бачимо:",
    ...row.reasons.slice(0, 6).map((reason) => `• ${reason}`),
    "",
    "Висновок:",
    row.status === "ACCUMULATION" ? "➡️ Розумні гроші набирають позицію" : row.status === "DISTRIBUTION" ? "➡️ Розподіл / вихід із позиції" : row.status === "CONFLICTED" ? "➡️ ⚠️ Конфлікт потоків — futures і spot не підтверджують одне одного" : "➡️ Нейтрально, немає якісної переваги"
  ].join("\n");
}

function formatWhaleRow(row: WhaleRow) {
  return [`${whaleStatusIcon(row.status)} ${row.symbol} — ${whaleStatusText(row.status)}`, `Впевненість входу: ${row.confidence}/100`, `Оцінка китів: ${row.score}/100`, "", "Причина:", ...row.reasons.slice(0, 4).map((reason) => `• ${reason}`)].join("\n");
}

function whaleStatusLabel(status: WhaleStatus) {
  return `${whaleStatusIcon(status)} ${whaleStatusText(status)}`;
}

function whaleStatusIcon(status: WhaleStatus) {
  if (status === "ACCUMULATION") return "🟢";
  if (status === "DISTRIBUTION") return "🔴";
  if (status === "CONFLICTED") return "⚠️";
  return "⚪";
}

function whaleStatusText(status: WhaleStatus) {
  if (status === "ACCUMULATION") return "КИТИ НАБИРАЮТЬ";
  if (status === "DISTRIBUTION") return "КИТИ ЗЛИВАЮТЬ";
  if (status === "CONFLICTED") return "КОНФЛІКТ ПОТОКІВ";
  return "НЕЙТРАЛЬНО";
}

function whaleReasons(input: { status: WhaleStatus; priceChange: number; oiChange: number; fundingRate: number; futuresVolumeSpike: number; spotVolumeSpike: number; futuresBias: number; spotBias: number; liquidationPressure: WhaleRow["liquidationPressure"]; accountRatio: number; spotImbalance: number }) {
  const out = [];
  out.push(`Futures: ${input.priceChange >= 0 ? "ціна ↑" : "ціна ↓"} + ${input.oiChange >= 0 ? "OI ↑" : "OI ↓"}`);
  out.push(input.spotBias > 12 ? "Spot: тиск покупців / накопичення" : input.spotBias < -12 ? "Spot: тиск продавців / розподіл" : "Spot: нейтральний потік");
  if (Math.max(input.futuresVolumeSpike, input.spotVolumeSpike) > 1.35) out.push(`Аномальний обсяг ${Math.max(input.futuresVolumeSpike, input.spotVolumeSpike).toFixed(1)}x`);
  if (input.liquidationPressure !== "neutral") out.push(`Тиск ліквідацій: ${input.liquidationPressure === "short squeeze" ? "short squeeze" : "long squeeze"}`);
  if (Math.abs(input.accountRatio) > 0.08) out.push(`Позиціонування: перекіс у ${input.accountRatio > 0 ? "LONG" : "SHORT"}`);
  if (Math.abs(input.fundingRate) > 0.00035) out.push(`Funding: ${input.fundingRate > 0 ? "позитивний" : "негативний"} ${input.fundingRate.toFixed(5)}`);
  if (input.status === "CONFLICTED") out.unshift(input.futuresBias > 0 ? "⚠️ Futures bullish, але Spot продає" : "⚠️ Futures bearish, але Spot купує");
  if (!out.length) out.push("Немає аномальної активності китів");
  return out;
}

function futuresDirection(priceChange: number, oiChange: number, imbalance: number, accountRatio: number) {
  let score = 0;
  if (priceChange > 0.002 && oiChange > 0.001) score += 34;
  else if (priceChange > 0.002 && oiChange < -0.001) score += 10;
  else if (priceChange < -0.002 && oiChange > 0.001) score -= 34;
  else if (priceChange < -0.002 && oiChange < -0.001) score -= 24;
  score += clampNumber(imbalance * 55, -18, 18);
  score += clampNumber(accountRatio * 70, -16, 16);
  return score;
}

function spotDirection(priceChange: number, volumeSpike: number, imbalance: number) {
  let score = clampNumber(imbalance * 70, -34, 34);
  if (volumeSpike > 1.35 && priceChange >= -0.001) score += 26;
  if (volumeSpike > 1.35 && priceChange < -0.001) score -= 26;
  if (priceChange > 0.003) score += 10;
  if (priceChange < -0.003) score -= 10;
  return score;
}

function squeezePressure(candles: Candle[], volumeSpike: number, priceChange: number): WhaleRow["liquidationPressure"] {
  const last = candles.at(-1);
  if (!last || volumeSpike < 1.5) return "neutral";
  const range = Math.max(last.high - last.low, last.close * 0.0001);
  const upperWick = (last.high - Math.max(last.open, last.close)) / range;
  const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
  if (priceChange > 0.002 && upperWick > 0.35) return "short squeeze";
  if (priceChange < -0.002 && lowerWick > 0.35) return "long squeeze";
  return "neutral";
}

function changeFrom(candles: Candle[], bars: number) {
  const last = candles.at(-1);
  const prev = candles.length > bars ? candles.at(-bars) : candles[0];
  return last && prev?.close ? (last.close - prev.close) / prev.close : 0;
}

function volumeSpikeRatio(candles: Candle[]) {
  if (candles.length < 12) return 1;
  const recent = candles.slice(-3).reduce((sum, candle) => sum + candle.volume, 0) / 3;
  const base = candles.slice(-15, -3).reduce((sum, candle) => sum + candle.volume, 0) / 12;
  return base > 0 ? recent / base : 1;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sampleWhaleRows(): WhaleRow[] {
  return [
    { symbol: "BTCUSDT", status: "ACCUMULATION", confidence: 82, score: 88, futuresBias: 45, spotBias: 39, priceChange: 0.006, oiChange: 0.004, fundingRate: 0.0001, volumeSpike: 1.8, liquidationPressure: "short squeeze", reasons: ["Futures: Price ↑ + OI ↑", "Spot: buy pressure / accumulation flow", "volume spike 1.8x", "Positioning: long skew"] },
    { symbol: "PEPEUSDT", status: "DISTRIBUTION", confidence: 74, score: 79, futuresBias: -38, spotBias: -31, priceChange: -0.005, oiChange: -0.002, fundingRate: 0.0002, volumeSpike: 1.6, liquidationPressure: "long squeeze", reasons: ["Spot: sell pressure / distribution flow", "Futures: Price ↓ + OI ↓", "volume spike 1.6x", "Liquidation pressure: long squeeze"] }
  ];
}

function normalizeWhalePair(input: string) {
  const pair = normalizePriorityPair(input);
  return pair.endsWith("USDT") ? pair : `${pair}USDT`;
}

function sampleMomentumRows(): MomentumMove[] {
  return [
    {
      symbol: "ESPORTSUSDT",
      direction: "LONG",
      mode: "SCALP",
      timeframe: "1m",
      movePct: 0.92,
      fromPrice: 0.0551,
      toPrice: 0.0556,
      turnover24h: 2_700_000,
      volumeSpike: 2.1,
      oiLabel: "Price ↑ + OI neutral",
      oiChange: 0.0008,
      whaleLabel: "Активність китів 69%",
      whaleScore: 69,
      setupType: "Quick scalp",
      momentum: "Very Strong",
      entryType: "MARKET ENTRY",
      entryReason: "1–5m імпульс активний",
      retest: [0.0551, 0.0553],
      potential: "HIGH",
      risk: "High",
      expectedHoldMinutes: "2–10 хв",
      reasons: ["volume spike 2.1x", "momentum acceleration", "whale activity", "orderbook imbalance", "short squeeze probability / liquidation cascade", "risk penalty: BTC mixed"],
      score: 76
    },
    {
      symbol: "ESPORTSUSDT",
      direction: "LONG",
      timeframe: "5m",
      movePct: 4.4,
      fromPrice: 0.05321,
      toPrice: 0.05555,
      turnover24h: 13_700_000,
      volumeSpike: 3.2,
      oiLabel: "Price ↑ + OI ↑",
      oiChange: 0.006,
      whaleLabel: "Accumulation 78%",
      whaleScore: 78,
      setupType: "Momentum breakout",
      momentum: "Strong",
      entryType: "LIMIT ENTRY",
      entryReason: "Retest: 0.05490 - 0.05510",
      retest: [0.0549, 0.0551],
      potential: "HIGH",
      risk: "Medium",
      reasons: ["volume spike", "OI confirmation", "whale accumulation", "spot confirms futures move", "breakout structure"],
      score: 84
    },
    {
      symbol: "PEPEUSDT",
      direction: "SHORT",
      timeframe: "15m",
      movePct: -6.1,
      fromPrice: 0.0000121,
      toPrice: 0.00001136,
      turnover24h: 41_000_000,
      volumeSpike: 2.8,
      oiLabel: "Price ↓ + OI ↑",
      oiChange: 0.004,
      whaleLabel: "Distribution 72%",
      whaleScore: 28,
      setupType: "Whale distribution",
      momentum: "Very Strong",
      entryType: "MARKET ENTRY",
      entryReason: "Breakout confirmed",
      retest: [0.0000115, 0.00001162],
      potential: "HIGH",
      risk: "Medium",
      reasons: ["volume spike", "OI confirmation", "whale distribution", "breakout structure"],
      score: 86
    }
  ];
}

function momentumTitle(filter: MomentumFilter) {
  if (filter === "scalp") return "⚡ SCALP MODE / 1–5m швидкі входи";
  if (filter === "scalp_long") return "⚡ Scalp LONG / 1–5m швидкі входи";
  if (filter === "scalp_short") return "⚡ Scalp SHORT / 1–5m швидкі входи";
  if (filter === "long") return "📈 Лідери LONG / Сканер сильних рухів";
  if (filter === "short") return "📉 Лідери SHORT / Сканер сильних рухів";
  if (filter === "strongest") return "🔥 Найсильніші рухи / Сканер сильних рухів";
  return "🚨 Великі рухи / Сканер сильних рухів";
}

function signalMenuText() {
  return topText();
}

function watchlistMenuText() {
  return watchlistText();
}

function monitoringText() {
  const pairs = loadPriorityWatchlist();
  if (!pairs.length) return "👀 Моніторинг\n\nСписок моніторингу порожній. Натисни ➕ Додати пару.";
  return ["👀 Моніторинг активний", "", ...pairs.map(monitoringStatusFor)].join("\n\n");
}

function settingsText() {
  const settings = loadTelegramSettings();
  return ["⚙️ Налаштування", "", `💰 Баланс: ${settings.balanceUsdt} USDT`, `⚡ Плече: ${settings.maxLeverage} максимум`, `🔔 Сповіщення: ${settings.notifications ? "увімкнено" : "вимкнено"}`, "📱 Telegram UX: кнопкове меню", `🎯 Режим ризику: ${riskModeUa(settings.riskMode)}`].join("\n");
}

function settingsDetailText(button: string) {
  const settings = loadTelegramSettings();
  if (button.startsWith("🔔")) return "🔔 Сповіщення\n\nАвто-пуші: тільки real entry, watchlist → entry upgrade та trade management.";
  if (button.startsWith("📱")) return "📱 Telegram UX\n\nУвімкнено чисте кнопкове меню, inline quick actions та короткий формат сигналів.";
  return `⚙️ Налаштування\n\nБаланс: ${settings.balanceUsdt} USDT\nПлече: ${settings.maxLeverage}\nСповіщення: ${settings.notifications ? "увімкнено" : "вимкнено"}\nРежим ризику: ${riskModeUa(settings.riskMode)}`;
}

function leverageText() {
  return ["⚡ Плече", "", `Поточний ліміт: ${loadTelegramSettings().maxLeverage}`, "", "Обери максимальне плече:", "x2", "x3"].join("\n");
}

function riskModeText() {
  return ["🎯 Режим ризику", "", `Поточний режим: ${riskModeUa(loadTelegramSettings().riskMode)}`, "", "Обережний — найменший ризик", "Збалансований — стандартний ризик", "Агресивний — більше ризику тільки для сильних сетапів"].join("\n");
}

function riskModeUa(value: RiskMode) {
  if (value === "Conservative") return "Обережний";
  if (value === "Balanced") return "Збалансований";
  return "Агресивний";
}

function helpText() {
  return [
    "📌 Команди",
    "",
    "/signal BTCUSDT — аналіз пари + постійний моніторинг",
    "/watch AIGENSYNUSDT — додати в список моніторингу",
    "/unwatch AIGENSYNUSDT — прибрати зі списку моніторингу",
    "/watchlist — список пар",
    "/watchstatus — активні сетапи, оцінка, відсутні підтвердження",
    "/top — найкращі сетапи зараз",
    "/newtokens — нові монети Bybit Futures",
    "/newsignal TOKENUSDT — аналіз нового futures токена",
    "/newwatch — якісні нові лістинги під моніторингом",
    "/market — стан ринку",
    "/intelligence — детектор пампу, перекіс китів, ліквідації, режим ринку",
    "/markethealth — режим, агресивність і активні пороги",
    "/btc — BTC фільтр",
    "/status — статус сканера",
    "/search BTCUSDT — пошук по всіх Bybit Spot/Futures і повний аналіз",
    "/stats — статистика журналу",
    "/performance — результативність стратегії",
    "/learning — статус безпечного навчання",
    "/resetlearning — скинути адаптивні ваги",
    "/paper on — увімкнути паперову торгівлю",
    "/paper off — вимкнути паперову торгівлю",
    "/paper — статистика паперової торгівлі",
    "/paperstats — статистика симуляції моніторингу",
    "/diagnostics — API і біржі",
    "/help — список команд"
  ].join("\n");
}

function paperModeText(enabled: boolean) {
  setPaperMode(enabled);
  return [enabled ? "✅ Паперова торгівля увімкнена" : "⏸ Паперова торгівля вимкнена", "", paperStatsText()].join("\n");
}

function statusText() {
  return [
    "🟢 Статус сканера",
    "",
    `Режим: ${state.diagnostics.mode}`,
    `Останній scan: ${state.diagnostics.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "очікується"}`,
    `Символів: ${state.diagnostics.scannedSymbols}`,
    `Сигналів сьогодні: ${state.stats.signalsToday}`,
    `Список моніторингу: ${loadPriorityWatchlist().join(", ") || "порожній"}`
  ].join("\n");
}

function diagnosticsText() {
  const api = Object.entries(state.diagnostics.apiStatus).map(([key, value]) => `${key}: ${value}`);
  const errors = Object.entries(state.diagnostics.authErrors).map(([key, value]) => `${key}: ${value}`);
  const bybit = state.diagnostics.apiStatus.bybit === "ok" || !state.diagnostics.authErrors.bybit;
  return [
    "🧪 Діагностика",
    "",
    `${bybit ? "✅" : "⚠️"} Bybit підключено`,
    `${config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID ? "✅" : "⚠️"} Telegram підключено`,
    "✅ Дашборд онлайн",
    `${loadPriorityWatchlist().length ? "✅" : "⚠️"} Список моніторингу активний`,
    `${state.diagnostics.lastScanAt ? "✅" : "⚠️"} Сканер активний`,
    ...(api.length ? ["", "API:", ...api] : []),
    ...(errors.length ? ["", "Помилки:", ...errors] : [])
  ].join("\n");
}

function btcText() {
  const latest = [...state.activeSignals, ...state.watchlist, ...state.history].find((signal) => signal.symbol === "BTCUSDT" || signal.btcStable !== undefined);
  const btcSignal = [...state.activeSignals, ...state.watchlist, ...state.history].find((signal) => signal.symbol === "BTCUSDT");
  return [
    "₿ BTC Фільтр",
    "",
    `Тренд: ${btcSignal?.side && btcSignal.side !== "NO_TRADE" ? btcSignal.side : "формується"}`,
    `Стабільність: ${latest?.btcStable ? "стабільний" : "нестабільний або немає даних"}`,
    `Напрям ринку: ${state.marketCondition}`,
    `Волатильність: ${btcSignal?.marketRegime ?? "немає даних"}`
  ].join("\n");
}

function marketHealthText() {
  const latest = [...state.activeSignals, ...state.watchlist, ...state.history].find(Boolean);
  const btcSignal = [...state.activeSignals, ...state.watchlist, ...state.history].find((signal) => signal.symbol === "BTCUSDT");
  const btcOk = latest?.btcStable ?? false;
  const regime = latest?.marketRegime ?? btcSignal?.marketRegime ?? "SIDEWAYS";
  const thresholds = marketThresholdProfile(regime, btcOk);
  const recent = state.history.slice(0, 20);
  const entries = recent.filter((signal) => !["NO_TRADE", "WATCHLIST"].includes(signal.side)).length;
  const watch = recent.filter((signal) => signal.side === "WATCHLIST").length;
  const noTrade = recent.filter((signal) => signal.side === "NO_TRADE").length;
  const avgScore = recent.length ? Math.round(recent.reduce((sum, signal) => sum + signal.score, 0) / recent.length) : 0;
  return [
    "🩺 Стан ринку",
    "",
    `Ринок: ${marketModeUa(thresholds.mode)}`,
    `BTC: ${btcOk ? "стабільний" : "нестабільний"}`,
    `Волатильність: ${regimeUaText(regime)}`,
    `Агресивність: ${aggressionUa(thresholds.aggression)}`,
    `Активні пороги: вхід ${thresholds.entry}+ / моніторинг ${thresholds.watch}+ / ранній сетап ${thresholds.early}+`,
    "",
    `Очікувана кількість сигналів: ${expectedSignals(thresholds.aggression, btcOk)}`,
    `Останній потік: ${entries} входів / ${watch} моніторинг / ${noTrade} без входу`,
    `Середня оцінка: ${avgScore || "немає даних"}`,
    "",
    "Чому сигналів мало/багато:",
    ...marketHealthReasons(recent, btcOk, thresholds.aggression)
  ].join("\n");
}

function expectedSignals(aggression: string, btcOk: boolean) {
  if (!btcOk) return "низька";
  if (aggression === "Balanced") return "нормальна: 1-2 входи, 4-6 пар у моніторинг на 20 перевірок";
  if (aggression === "Selective fast momentum") return "середня: тільки швидкі чисті сетапи";
  return "низька";
}

function marketHealthReasons(recent: Signal[], btcOk: boolean, aggression: string) {
  const reasons: string[] = [];
  if (!btcOk) reasons.push("⚠️ BTC-фільтр обмежує входи в альти");
  if (aggression === "Conservative") reasons.push("⚠️ Боковий/слабкий режим тримає строгий поріг входу 92+");
  const weakVolume = recent.filter((signal) => (signal.scoreBreakdown.volumeConfirmation ?? 0) < 65).length;
  const weakSniper = recent.filter((signal) => (signal.scoreBreakdown.entrySniper ?? 0) < 70).length;
  const fakeRisk = recent.filter((signal) => signal.fakeBreakout?.risk).length;
  if (weakVolume >= Math.max(3, recent.length / 3)) reasons.push("⚠️ Підтвердження обсягом слабке у більшості останніх перевірок");
  if (weakSniper >= Math.max(3, recent.length / 3)) reasons.push("⚠️ Sniper/ретест ще не готовий у більшості сетапів");
  if (fakeRisk) reasons.push("⚠️ Захист від fake breakout активний");
  if (!reasons.length) reasons.push("✅ Фільтри ринку здорові; сканер може швидко оновити моніторинг до входу");
  return reasons.slice(0, 5);
}

function positionsText() {
  return "🔍 Пошук по парах\n\nВведи пару для професійного аналізу, наприклад BTCUSDT або btc.";
}

function topText() {
  const top = topSignals();
  if (!top.length) return ["📊 Сигнали / 🔥 Топ Сетапи", "", "Активних entry/watchlist setup зараз немає.", "", marketText()].join("\n");
  return ["📊 Сигнали / 🔥 Топ Сетапи", "", ...top.map(topLine)].join("\n");
}

function topSignals() {
  const seen = new Set<string>();
  return [...state.activeSignals, ...state.watchlist, ...state.history]
    .filter((signal) => signal.side !== "NO_TRADE" && setupBucket(signal.score) !== "ignore")
    .sort((a, b) => b.score - a.score)
    .filter((signal) => {
      const key = signalKey(signal);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function watchlistText() {
  const pairs = loadPriorityWatchlist();
  const ranked = rankedWatchlist();
  return [
    "👀 Список моніторингу / ТОП",
    "",
    ...(ranked.length ? ranked.slice(0, 10).map((signal, index) => `#${index + 1} ${signal.symbol} — ${signal.score}/100`) : ["Активних сетапів 72+ поки немає"]),
    "",
    "Пріоритетні пари:",
    ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["Список моніторингу порожній"])
  ].join("\n");
}

function watchStatusText() {
  const ranked = rankedWatchlist();
  if (!ranked.length) return ["👀 Статус моніторингу", "", "Активних сетапів 72+ зараз немає.", "Сканер продовжує моніторинг без FOMO."].join("\n");
  return ["👀 Список моніторингу / ТОП", "", ...ranked.slice(0, 8).map(watchStatusCard)].join("\n\n");
}

function rankedWatchlist() {
  return state.watchlist
    .filter((signal) => signal.mode === "futures" && signal.score >= 40)
    .sort((a, b) => readinessScore(b) - readinessScore(a));
}

function watchStatusCard(signal: Signal, index: number) {
  const missing = missingWatchConfirmations(signal);
  return [
    `#${index + 1} ${signal.symbol}`,
    "",
    `${signal.score}/100`,
    "",
    "Готовність:",
    `${readinessPercent(signal)}%`,
    "",
    "Відсутні підтвердження:",
    ...(missing.length ? missing.map((item) => `⚠️ ${item}`) : ["✅ тригер входу майже готовий"]),
    "",
    "Оцінка готовності:",
    readinessLabel(signal)
  ].join("\n");
}

function missingWatchConfirmations(signal: Signal) {
  const missing: string[] = [];
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) < 70) missing.push("ретест / sweep ліквідності");
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) missing.push("підтвердження обсягом");
  if ((signal.scoreBreakdown.openInterestConfirmation ?? 0) < 58) missing.push("зростання OI");
  if ((signal.scoreBreakdown.momentumQuality ?? 0) < 70) missing.push("зміна імпульсу");
  if ((signal.scoreBreakdown.orderBookImbalance ?? 0) < 60) missing.push("покращення стакана");
  if ((signal.scoreBreakdown.entrySniper ?? 0) < 70) missing.push("sniper-тригер");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") missing.push("стабільність BTC");
  return missing.slice(0, 5);
}

function readinessScore(signal: Signal) {
  const confirmations = 7 - missingWatchConfirmations(signal).length;
  return signal.score * 10 + confirmations * 12 + (signal.scoreBreakdown.entrySniper ?? 0) * 0.2 + (signal.scoreBreakdown.liquiditySweep ?? 0) * 0.15;
}

function readinessPercent(signal: Signal) {
  const confirmations = 7 - missingWatchConfirmations(signal).length;
  return Math.min(99, Math.max(40, Math.round(signal.score * 0.65 + confirmations / 7 * 35)));
}

function readinessLabel(signal: Signal) {
  const missing = missingWatchConfirmations(signal).length;
  if (signal.score >= 88 && missing <= 2) return "висока";
  if (signal.score >= 82 && missing <= 4) return "середня";
  return "рання";
}

function signalAnalysisText(pair: string) {
  const signal = findSignal(pair);
  if (!signal) return ["🔍 Аналіз запущено", "", pair, "", "Пара додана в постійний моніторинг.", "Live scanner перевіряє Bybit і поверне setup після підтвердження.", "", monitoringStatusFor(pair)].join("\n");
  return compactSignalCard(signal);
}

function watchAddedText(pair: string) {
  return [
    `✅ ${pair} додано до списку моніторингу`,
    "",
    "👀 Моніторинг активний",
    "⏱ Перевірка еволюції кожні 2 хв",
    "",
    monitoringStatusFor(pair)
  ].join("\n");
}

function monitoringStatusFor(pair: string) {
  const signal = findSignal(pair);
  if (!signal) return [pair, "", "Статус:", "Дані сканера ще формуються"].join("\n");
  const side = signal.side === "WATCHLIST" ? `внутрішній моніторинг ${signal.score}/100` : signal.side === "NO_TRADE" ? "немає активного входу" : `${sideUa(signal.side)} ${signal.score}%`;
  return [pair, "", "Статус:", side, "", signal.side === "WATCHLIST" ? `Готовність: ${readinessLabel(signal)}` : signal.management].join("\n");
}

function findSignal(pair: string) {
  return [...state.activeSignals, ...state.watchlist, ...state.history].find((item) => item.symbol === pair);
}

function signalSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return `${sideUa(side as Signal["side"])} ${signal.symbol}\nОцінка сетапу: ${signal.score}/100 · ${entryStatusUa(signal.entryStatus)}\nВхід: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`;
}

function compactSignalCard(signal: Signal) {
  return formatDecisionSignal(signal);
}

function signalKey(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return [signal.symbol, side, signal.mode, fmt(signal.entry[0]), fmt(signal.entry[1])].join(":");
}

function sideUa(side: Signal["side"] | "LONG" | "SHORT") {
  if (side === "NO_TRADE") return "без входу";
  if (side === "WATCHLIST") return "моніторинг";
  if (side === "BUY" || side === "LONG") return "LONG";
  return "SHORT";
}

function entryStatusUa(status: Signal["entryStatus"]) {
  if (status === "ENTER_NOW") return "можна входити";
  if (status === "WAIT_FOR_ENTRY") return "очікування входу";
  return "без входу";
}

function topLine(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  const icon = side === "SHORT" ? "🔴" : side === "WATCHLIST" ? "⚠️" : "🟢";
  return `${icon} ${sideUa(side as Signal["side"])} ${signal.symbol} — ${signal.score}% · ${setupBucketUa(signal.score)}`;
}

function setupBucket(score: number) {
  if (score < 40) return "ignore";
  if (score < 60) return "weak";
  if (score < 75) return "possible";
  if (score < 85) return "strong";
  return "entry";
}

function setupBucketUa(score: number) {
  const bucket = setupBucket(score);
  if (bucket === "weak") return "слабкий watchlist";
  if (bucket === "possible") return "можливий сетап";
  if (bucket === "strong") return "сильний сетап";
  if (bucket === "entry") return "кандидат на вхід";
  return "ігнор";
}

function positionSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return [
    `${sideUa(side as Signal["side"])} ${signal.symbol} — ${signal.score}%`,
    `Вхід: ${fmt(signal.entry[0])}-${fmt(signal.entry[1])}`,
    `SL: ${fmt(signal.stopLoss)}`,
    `TP: ${signal.takeProfit.map(fmt).join(" / ")}`,
    "Беззбитковість: після TP1",
    `Статус: ${entryStatusUa(signal.entryStatus)}`
  ].join("\n");
}

function pairSearchText(result: { query: string; futures: MarketRegistryItem[]; spot: MarketRegistryItem[]; best?: MarketRegistryItem }) {
  const best = result.best;
  const health = best ? marketHealth(best) : null;
  return [
    "🔍 Пошук по парах",
    "",
    `Запит: ${result.query}`,
    "",
    "Знайдено:",
    "",
    "📈 Futures:",
    result.futures.length ? result.futures.slice(0, 5).map(shortMarketLine).join("\n") : "не знайдено",
    "",
    "💰 Spot:",
    result.spot.length ? result.spot.slice(0, 5).map(shortMarketLine).join("\n") : "не знайдено",
    "",
    best && health ? "Стан ринку:" : "",
    best && health ? `${health.label} (${health.score}/100)` : "",
    best ? `Обсяг: ${formatUsd(best.turnover24h)}` : "",
    best ? `Ліквідність: ${best.liquidity}/100` : "",
    best ? `Spread: ${(best.spreadPct * 100).toFixed(3)}%` : "",
    best ? `Волатильність: 24h ${(best.price24hPcnt * 100).toFixed(2)}%` : ""
  ].filter(Boolean).join("\n");
}

function pairNotFoundText(query: string, suggestions: MarketRegistryItem[]) {
  return [
    "🔍 Пошук по парах",
    "",
    `Пара не знайдена: ${query}`,
    suggestions.length ? "" : "Спробуй формат BTCUSDT або PEPEUSDT.",
    suggestions.length ? "Можливі варіанти:" : "",
    ...suggestions.slice(0, 8).map((item) => `${item.symbol} · ${item.marketType}`)
  ].filter(Boolean).join("\n");
}

function futuresExecutionAnalysisText(signal: Signal, _market?: MarketRegistryItem, result?: { query: string; futures: MarketRegistryItem[]; spot: MarketRegistryItem[] }) {
  return [
    formatExecutionSignal(signal),
    result?.query ? `\nЗапит: ${result.query}` : ""
  ].filter(Boolean).join("\n");
}

function spotExecutionAnalysisText(analysis: Awaited<ReturnType<typeof analyzeSpot>>) {
  const ready = analysis.suitability.shortTermTrade || analysis.suitability.midTermHold;
  const decision = ready && analysis.shortTerm.confidence >= 62 ? "🟢 LONG" : "⚪ ЧЕКАТИ / БЕЗ ВХОДУ";
  const wait = decision.includes("WAIT");
  const sl = analysis.longTerm.accumulationZone[0] * 0.97;
  return [
    `${decision} — ${analysis.symbol}`,
    "",
    `📍 Зона входу: ${analysis.longTerm.accumulationZone.map(fmt).join(" - ")}`,
    "➡️ LONG сетап",
    "",
    `🛑 SL: ${fmt(sl)}`,
    `🎯 TP1: ${fmt(analysis.longTerm.resistance[0])}`,
    `🎯 TP2: ${fmt(analysis.longTerm.resistance[1])}`,
    `🎯 TP3: ${analysis.longTerm.growthPotential}`,
    "",
    "⚡ spot",
    `📊 Впевненість входу: ${analysis.shortTerm.confidence}/100`,
    "",
    "Причина:",
    ...spotExecutionReasons(analysis, wait).map((reason) => `• ${reason}`),
    wait ? "" : null,
    wait ? "⏱ Повторна перевірка: 2 хв" : null
  ].filter(Boolean).join("\n");
}

function spotExecutionReasons(analysis: Awaited<ReturnType<typeof analyzeSpot>>, noTrade: boolean) {
  const positive = [
    analysis.metrics.momentumScore >= 60 ? "імпульс підтверджений" : null,
    analysis.metrics.trendScore >= 60 ? "тренд підтверджений" : null,
    analysis.metrics.volume24h >= 1_000_000 ? "обсяг підтверджений" : null,
    analysis.metrics.health.score >= 55 ? "ліквідність нормальна" : null,
    analysis.metrics.btcCorrelation > -0.4 ? "BTC стабільний" : null
  ].filter(Boolean) as string[];
  const blockers = [
    analysis.metrics.volume24h < 1_000_000 ? "слабкий обсяг" : null,
    analysis.metrics.momentumScore < 55 ? "слабкий імпульс" : null,
    analysis.metrics.price > analysis.longTerm.accumulationZone[1] ? "немає ретесту" : null,
    analysis.metrics.health.score < 55 ? "слабка ліквідність" : null,
    analysis.longTerm.riskProfile === "Extreme" ? "високий ризик" : null
  ].filter(Boolean) as string[];
  if (noTrade) return blockers.slice(0, 5);
  return [...positive, ...blockers.filter((reason) => !positive.includes(reason))].slice(0, 5);
}

function futuresTraderBriefText(signal: Signal) {
  const decision = futuresBriefDecision(signal);
  const direction = futuresSetupDirection(signal);
  const confirmations = futuresBriefConfirmations(signal);
  const blockers = futuresBriefBlockers(signal);
  return [
    "━━━━━━━━━━",
    `${decision} — ${signal.symbol}`,
    "",
    "Причина одним реченням:",
    futuresBriefReason(signal, decision, confirmations, blockers),
    "",
    `📍 Вхід: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
    `➡️ ${direction} сетап`,
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    `🎯 TP1: ${fmt(signal.takeProfit[0])}`,
    `🎯 TP2: ${fmt(signal.takeProfit[1])}`,
    `🎯 TP3: ${fmt(signal.takeProfit[2])}`,
    "",
    `📊 Впевненість входу: ${signal.confidence}/100`,
    `⚖️ RR: ${signal.riskReward}`,
    "",
    "Коротко що підтверджує:",
    ...confirmations.map((item) => `• ${item}`),
    "",
    "Коротко що заважає:",
    ...blockers.map((item) => `• ${item}`),
    "━━━━━━━━━━"
  ].join("\n");
}

function spotTraderBriefText(analysis: Awaited<ReturnType<typeof analyzeSpot>>) {
  const ready = analysis.suitability.shortTermTrade || analysis.suitability.midTermHold;
  const decision = ready && analysis.shortTerm.confidence >= 62 ? "🟢 LONG" : "⚪ ЧЕКАТИ";
  const sl = analysis.longTerm.accumulationZone[0] * 0.97;
  const confirmations = spotBriefConfirmations(analysis);
  const blockers = spotExecutionReasons(analysis, decision.includes("WAIT"));
  return [
    "━━━━━━━━━━",
    `${decision} — ${analysis.symbol}`,
    "",
    "Причина одним реченням:",
    spotBriefReason(analysis, decision, confirmations, blockers),
    "",
    `📍 Вхід: ${analysis.longTerm.accumulationZone.map(fmt).join(" - ")}`,
    "➡️ LONG сетап",
    `🛑 SL: ${fmt(sl)}`,
    `🎯 TP1: ${fmt(analysis.longTerm.resistance[0])}`,
    `🎯 TP2: ${fmt(analysis.longTerm.resistance[1])}`,
    `🎯 TP3: ${analysis.longTerm.growthPotential}`,
    "",
    `📊 Впевненість входу: ${analysis.shortTerm.confidence}/100`,
    `⚖️ RR: ${spotRiskReward(analysis.metrics.price, sl, analysis.longTerm.resistance[0])}`,
    "",
    "Коротко що підтверджує:",
    ...confirmations.map((item) => `• ${item}`),
    "",
    "Коротко що заважає:",
    ...blockers.map((item) => `• ${item}`),
    "━━━━━━━━━━"
  ].join("\n");
}

function futuresBriefDecision(signal: Signal) {
  if ((signal.side === "LONG" || signal.side === "BUY") && signal.entryStatus !== "NO_TRADE") return "🟢 LONG";
  if (signal.side === "SHORT" && signal.entryStatus !== "NO_TRADE") return "🔴 SHORT";
  return "⚪ ЧЕКАТИ";
}

function futuresSetupDirection(signal: Signal) {
  if (signal.side === "SHORT") return "SHORT";
  if (signal.side === "LONG" || signal.side === "BUY") return "LONG";
  return signal.higherTimeframe.direction < 0 ? "SHORT" : "LONG";
}

function futuresBriefConfirmations(signal: Signal) {
  const breakdown = signal.scoreBreakdown ?? {};
  const items = [
    (breakdown.momentumQuality ?? 0) >= 70 ? "імпульс" : null,
    signal.correlation.aligned || signal.btcStable || signal.symbol === "BTCUSDT" ? "кореляція BTC" : null,
    (breakdown.liquiditySweep ?? 0) >= 65 || (breakdown.orderBookImbalance ?? 0) >= 60 ? "ліквідність" : null,
    signal.higherTimeframe.aligned || (breakdown.multiTimeframeAlignment ?? 0) >= 55 ? "тренд" : null
  ].filter(Boolean) as string[];
  return items.length ? items.slice(0, 4) : ["немає сильного підтвердження"];
}

function futuresBriefBlockers(signal: Signal) {
  const breakdown = signal.scoreBreakdown ?? {};
  const items = [
    signal.fakeBreakout.risk ? "ризик fake breakout" : null,
    (breakdown.volumeConfirmation ?? 0) < 65 ? "слабкий обсяг" : null,
    (breakdown.entrySniper ?? 0) < 70 ? "немає sniper-тригера" : null,
    (breakdown.liquiditySweep ?? 0) < 65 ? "слабкий ретест" : null,
    !signal.btcStable && signal.symbol !== "BTCUSDT" ? "ризик кореляції BTC" : null
  ].filter(Boolean) as string[];
  return items.length ? items.slice(0, 4) : ["критичних перешкод немає"];
}

function futuresBriefReason(signal: Signal, decision: string, confirmations: string[], blockers: string[]) {
  if (decision.includes("ЧЕКАТИ")) return `Чекаємо, бо ${blockers[0] ?? "немає чистого входу"}.`;
  return `${decision.replace(/^[^\s]+\s/, "")} сценарій активний, бо ${confirmations.slice(0, 2).join(" і ")}; головний ризик: ${blockers[0] ?? "низький"}.`;
}

function spotBriefConfirmations(analysis: Awaited<ReturnType<typeof analyzeSpot>>) {
  const items = [
    analysis.metrics.momentumScore >= 60 ? "імпульс" : null,
    analysis.metrics.btcCorrelation > -0.4 ? "кореляція BTC" : null,
    analysis.metrics.health.score >= 55 ? "ліквідність" : null,
    analysis.metrics.trendScore >= 60 ? "тренд" : null
  ].filter(Boolean) as string[];
  return items.length ? items.slice(0, 4) : ["немає сильного підтвердження"];
}

function spotBriefReason(analysis: Awaited<ReturnType<typeof analyzeSpot>>, decision: string, confirmations: string[], blockers: string[]) {
  if (decision.includes("ЧЕКАТИ")) return `Чекаємо, бо ${blockers[0] ?? "немає чистого входу"}.`;
  return `LONG сценарій активний, бо ${confirmations.slice(0, 2).join(" і ")}; головний ризик: ${blockers[0] ?? analysis.longTerm.riskProfile}.`;
}

function futuresProfessionalAnalysisText(signal: Signal, market?: MarketRegistryItem, result?: { query: string; futures: MarketRegistryItem[]; spot: MarketRegistryItem[] }) {
  const status = realStatus(signal);
  const breakdown = signal.scoreBreakdown ?? {};
  const oi = signal.openInterestAnalysis;
  const funding = signal.scoreBreakdown.fundingConfirmation ?? 0;
  const intel = signal.intelligence;
  return [
    `🔍 Пошук по парах — ${signal.symbol}`,
    "",
    result ? `Запит: ${result.query}` : "",
    `Тип ринку: futures / perpetual${market?.quoteAsset ? ` / ${market.quoteAsset}` : ""}`,
    result?.spot.length ? `Також є Spot: ${result.spot.slice(0, 3).map((item) => item.symbol).join(", ")}` : "Spot: не знайдено або нижча ліквідність",
    "",
    "КОРОТКИЙ ТЕРМІН:",
    `Scalp: ${scalpOutlook(signal)}`,
    `Intraday: ${intradayOutlook(signal)}`,
    `5m прогноз: ${scoreLabel(breakdown.fastMoveQuality ?? breakdown.entrySniper)} / ${signal.fastMoveQuality.message}`,
    `15m прогноз: ${signal.side === "NO_TRADE" ? "немає якісного входу" : signal.side === "WATCHLIST" ? "тільки моніторинг" : sideUa(signal.side)}`,
    `1h прогноз: ${signal.higherTimeframe.aligned ? "узгоджено" : signal.higherTimeframe.counterTrend ? "ризик контртренду" : "змішано"}`,
    "",
    "ДОВГИЙ ТЕРМІН:",
    `Swing: ${signal.higherTimeframe.score >= 70 ? "перевага продовження" : signal.higherTimeframe.counterTrend ? "ризик розвороту" : "діапазон/змішано"}`,
    `Continuation: ${signal.higherTimeframe.aligned && !signal.fakeBreakout.risk ? "так" : "потрібне підтвердження"}`,
    `Reversal: ${signal.marketRegime === "REVERSAL" ? "активний сценарій" : "не основний сценарій"}`,
    `Накопичення/розподіл: ${signal.marketRegime === "SIDEWAYS" || signal.marketRegime === "LOW_VOLATILITY" ? "діапазон накопичення/розподілу" : "немає явної зони"}`,
    "",
    "Професійний аналіз:",
    `Тренд: ${regimeUaText(signal.marketRegime)}`,
    `Імпульс: ${scoreLabel(breakdown.momentumQuality)}`,
    `Обсяг: ${scoreLabel(breakdown.volumeConfirmation)}${market ? ` / 24h ${formatUsd(market.turnover24h)}` : ""}`,
    `OI: ${oi.message} (${oi.score}/100)`,
    `Funding: ${fundingText(signal)} (${funding}/100)`,
    `Ліквідність: ${scoreLabel(market?.liquidity ?? breakdown.liquidity)}${market ? ` / ${formatUsd(market.turnover24h)}` : ""}`,
    `Spread: ${market ? `${(market.spreadPct * 100).toFixed(3)}%` : "немає даних"}`,
    `Кореляція BTC: ${signal.correlation.aligned ? "узгоджено" : signal.correlation.riskOff ? "risk-off" : "змішано"}`,
    `Режим ринку: ${regimeUaText(signal.marketRegime)}`,
    `Sniper-тригер: ${scoreLabel(breakdown.entrySniper)}`,
    `Статус ретесту: ${scoreLabel(breakdown.liquiditySweep)} / ${signal.liquidityIntelligence.message}`,
    `Ризик маніпуляції: ${manipulationRisk(signal)}`,
    `Активність китів: ${scoreLabel(breakdown.whaleActivity)}${intel ? ` / ${biasUa(intel.whale.whaleBias)} ${intel.whale.smartMoneyScore}/100` : ""}`,
    `Тиск ліквідацій: ${intel ? `${biasUa(intel.liq.sweepDirection)} / сила ${intel.liq.liqSignalStrength}/100 / пастка ${intel.liq.trapProbability}/100` : signal.liquidityIntelligence.message}`,
    "",
    "ВХІД:",
    `📍 зона входу: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    `🎯 TP1: ${fmt(signal.takeProfit[0])}`,
    `🎯 TP2: ${fmt(signal.takeProfit[1])}`,
    `🎯 TP3: ${fmt(signal.takeProfit[2])}`,
    `Впевненість входу: ${signal.confidence}/100 / оцінка сетапу ${signal.score}/100`,
    `RR: ${signal.riskReward}`,
    `СТАТУС: ${statusUa(status)}`,
    "",
    signal.rejectionReason ? `Фільтр: ${signal.rejectionReason}` : "Фільтр: setup валідний тільки після підтвердження entry-зони",
    "Причини:",
    ...signal.reasons.slice(0, 5).map((reason) => `• ${reason}`)
  ].filter(Boolean).join("\n");
}

function spotProfessionalAnalysisText(analysis: Awaited<ReturnType<typeof analyzeSpot>>, market?: MarketRegistryItem, result?: { query: string; futures: MarketRegistryItem[]; spot: MarketRegistryItem[] }) {
  const ready = analysis.suitability.shortTermTrade || analysis.suitability.midTermHold;
  const status = ready && analysis.shortTerm.confidence >= 72 ? "✅ ГОТОВО" : analysis.shortTerm.confidence >= 62 ? "👀 МОНІТОРИНГ" : "❌ БЕЗ ВХОДУ";
  const sl = analysis.longTerm.accumulationZone[0] * 0.97;
  return [
    `🔍 Пошук по парах — ${analysis.symbol}`,
    "",
    result ? `Запит: ${result.query}` : "",
    "Тип ринку: spot",
    result?.futures.length ? `Також є Futures: ${result.futures.slice(0, 3).map((item) => item.symbol).join(", ")}` : "Futures: не знайдено або нижча ліквідність",
    "",
    "КОРОТКИЙ ТЕРМІН:",
    `Scalp: ${analysis.shortTerm.scalping}`,
    `Intraday: ${analysis.shortTerm.intraday}`,
    `5m прогноз: недоступно для spot-скальпінгу`,
    `15m прогноз: ${analysis.shortTerm.scalping}`,
    `1h прогноз: ${analysis.shortTerm.intraday}`,
    "",
    "ДОВГИЙ ТЕРМІН:",
    `Swing: ${analysis.shortTerm.swing}`,
    `Continuation: ${analysis.metrics.trendScore >= 65 ? "можлива" : "потрібне підтвердження"}`,
    `Розворот: ${analysis.longTerm.marketCycle.includes("Distribution") ? "ризик від resistance" : "не основний сценарій"}`,
    `Накопичення/розподіл: ${analysis.longTerm.marketCycle}`,
    "",
    "Професійний аналіз:",
    `Тренд: ${analysis.metrics.trendScore}/100`,
    `Імпульс: ${analysis.metrics.momentumScore}/100`,
    `Обсяг: ${formatUsd(analysis.metrics.volume24h)}`,
    "OI: N/A для spot",
    "Funding: недоступний для spot",
    `Ліквідність: ${analysis.metrics.liquidity}/100`,
    `Spread: ${(analysis.metrics.spreadPct * 100).toFixed(3)}%`,
    `Кореляція BTC: ${analysis.metrics.btcCorrelation.toFixed(2)}`,
    `Режим ринку: ${analysis.longTerm.marketCycle}`,
    `Sniper-тригер: ${ready ? "очікувати підтвердження біля smart entry" : "не готовий"}`,
    `Статус ретесту: ${analysis.metrics.price <= analysis.longTerm.accumulationZone[1] ? "біля accumulation/retest" : "чекати відкат"}`,
    `Ризик маніпуляції: ${spotManipulationRisk(analysis)}`,
    `Активність китів: ${analysis.metrics.whaleScore}/100`,
    "Тиск ліквідацій: недоступний для spot",
    "",
    "ВХІД:",
    `📍 зона входу: ${analysis.longTerm.accumulationZone.map(fmt).join(" - ")}`,
    `🛑 SL: ${fmt(sl)}`,
    `🎯 TP1: ${fmt(analysis.longTerm.resistance[0])}`,
    `🎯 TP2: ${fmt(analysis.longTerm.resistance[1])}`,
    `🎯 TP3: ${analysis.longTerm.growthPotential}`,
    `Впевненість входу: ${analysis.shortTerm.confidence}/100 коротко / ${analysis.longTerm.confidence}/100 довго`,
    `RR: ${spotRiskReward(analysis.metrics.price, sl, analysis.longTerm.resistance[0])}`,
    `СТАТУС: ${status}`,
    market ? `Стан ринку: ${marketHealthLabelUa(marketHealth(market).label)} (${marketHealth(market).score}/100)` : "",
    "",
    "Причини:",
    ...analysis.reasons.map((reason) => `• ${reason}`)
  ].filter(Boolean).join("\n");
}

function realStatus(signal: Signal) {
  if (signal.entryStatus === "ENTER_NOW" && signal.side !== "NO_TRADE" && signal.side !== "WATCHLIST") return "🚀 МОЖНА ВХОДИТИ";
  if (signal.entryStatus === "WAIT_FOR_ENTRY" && signal.score >= 88) return "✅ ГОТОВО ДО ПІДТВЕРДЖЕННЯ";
  if (signal.side === "WATCHLIST" || signal.score >= 72) return "👀 МОНІТОРИНГ";
  return "❌ БЕЗ ВХОДУ";
}

function statusUa(value: string) {
  return value;
}

function marketHealthLabelUa(value: string) {
  if (value === "Strong") return "сильний";
  if (value === "Tradable") return "торговий";
  if (value === "Thin/Risky") return "тонкий/ризиковий";
  return value;
}

function scalpOutlook(signal: Signal) {
  const breakdown = signal.scoreBreakdown ?? {};
  if ((breakdown.entrySniper ?? 0) >= 90 && (breakdown.fastMoveQuality ?? 0) >= 70) return "можливий sniper-скальп після тригера";
  if ((breakdown.entrySniper ?? 0) >= 70) return "чекати підтвердження ретесту";
  return "скальп-входу немає";
}

function intradayOutlook(signal: Signal) {
  if (signal.side === "NO_TRADE") return "залишатися поза ринком";
  if (signal.side === "WATCHLIST") return "моніторинг до підтвердження зони входу";
  return `${sideUa(signal.side)} продовження, якщо BTC і режим ринку залишаються узгодженими`;
}

function manipulationRisk(signal: Signal) {
  const intel = signal.intelligence;
  const risks = [
    signal.fakeBreakout.risk ? "fake-breakout" : null,
    signal.orderFlow.trapRisk ? "пастка order flow" : null,
    intel && intel.whale.trapRisk >= 70 ? "пастка китів" : null,
    intel && intel.liq.trapProbability >= 70 ? "ліквідаційна пастка" : null,
    signal.marketRegime === "MANIPULATION_RISK" ? "ризиковий режим" : null
  ].filter(Boolean);
  return risks.length ? `ВИСОКИЙ (${risks.join(", ")})` : "НИЗЬКИЙ/СЕРЕДНІЙ";
}

function spotManipulationRisk(analysis: Awaited<ReturnType<typeof analyzeSpot>>) {
  if (analysis.metrics.spreadPct > 0.01 || analysis.longTerm.riskProfile === "Extreme") return "ВИСОКИЙ";
  if (analysis.metrics.whaleScore < 35 || analysis.longTerm.riskProfile === "High") return "СЕРЕДНІЙ";
  return "НИЗЬКИЙ";
}

function scoreLabel(value: number | undefined) {
  return typeof value === "number" ? `${Math.round(value)}/100` : "немає даних";
}

function spotRiskReward(price: number, stop: number, target: number) {
  const risk = Math.max(price - stop, 1e-9);
  const reward = Math.max(target - price, 0);
  return `1:${(reward / risk).toFixed(1)}`;
}

function shortMarketLine(item: MarketRegistryItem) {
  return `${item.symbol} · ${formatUsd(item.turnover24h)} · spread ${(item.spreadPct * 100).toFixed(3)}%`;
}

function spotAnalysisText(analysis: Awaited<ReturnType<typeof analyzeSpot>>) {
  return [
    `💰 SPOT Analysis — ${analysis.symbol}`,
    "",
    "Short-term:",
    `Scalping: ${analysis.shortTerm.scalping}`,
    `Intraday: ${analysis.shortTerm.intraday}`,
    `Swing: ${analysis.shortTerm.swing}`,
    "",
    "Long-term:",
    `Bias: ${analysis.longTerm.bias}`,
    `Risk: ${analysis.longTerm.riskProfile}`,
    `Accumulation: ${analysis.longTerm.accumulationZone.map(fmt).join(" - ")}`,
    `Resistance: ${analysis.longTerm.resistance.map(fmt).join(" - ")}`,
    `Potential: ${analysis.longTerm.growthPotential}`,
    `Cycle: ${analysis.longTerm.marketCycle}`,
    "",
    "Good for:",
    `${analysis.suitability.shortTermTrade ? "✅" : "❌"} short-term trade`,
    `${analysis.suitability.midTermHold ? "✅" : "❌"} mid-term hold`,
    `${analysis.suitability.longTermInvestment ? "✅" : "❌"} long-term investment`,
    "",
    "Reason:",
    ...analysis.reasons.map((reason) => `• ${reason}`)
  ].join("\n");
}

function formatUsd(value: number) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function marketText() {
  const latest = [...state.activeSignals, ...state.watchlist, ...state.history][0];
  return [
    "📈 Ринок:",
    state.marketCondition || "формується",
    "",
    "BTC:",
    latest?.btcStable ? "Стабільний" : "Нестабільний або немає даних",
    "",
    "Funding:",
    latest ? fundingText(latest) : "немає даних",
    "",
    "Ризик:",
    latest && latest.newsRisk.severity !== "HIGH" ? "низький" : "підвищений"
  ].join("\n");
}

function intelligenceText(section: "overview" | "pump" | "whale" | "liq" | "market") {
  const latest = latestIntelligence();
  if (!latest) return ["📡 Інтелект", "", "Дані ще формуються.", "Live-сканер має завершити хоча б одну futures-перевірку."].join("\n");
  const [symbol, intel] = latest;
  const header = ["📡 Інтелект", "", `Пара: ${symbol}`, `Оновлено: ${new Date(intel.updatedAt).toLocaleTimeString()}`, ""];
  if (section === "pump") return [...header, "Детектор пампу", ...intel.pump.reasons.map(intelReasonUa), `Оцінка: ${intel.pump.pumpScore}/100`, `Імпульс: ${intel.pump.momentumStrength}/100`, `Пробій: ${intel.pump.breakoutProbability}/100`, `Таймінг: ${entryTimingUa(intel.pump.entryTiming)}`].join("\n");
  if (section === "whale") return [...header, "Перекіс китів", ...intel.whale.reasons.map(intelReasonUa), `Перекіс: ${biasUa(intel.whale.whaleBias)}`, `Розумні гроші: ${intel.whale.smartMoneyScore}/100`, `Впевненість: ${intel.whale.whaleConfidence}/100`, `Ризик пастки: ${intel.whale.trapRisk}/100`].join("\n");
  if (section === "liq") return [...header, "Статус ліквідацій", ...intel.liq.reasons.map(intelReasonUa), `Сила: ${intel.liq.liqSignalStrength}/100`, `Sweep: ${biasUa(intel.liq.sweepDirection)}`, `Якість входу: ${intel.liq.entryQuality}/100`, `Пастка: ${intel.liq.trapProbability}/100`].join("\n");
  if (section === "market") return [...header, "Режим ринку", ...intel.market.reasons.map(intelReasonUa), `Режим: ${regimeUaText(intel.market.marketRegime)}`, `Ризик: ${intel.market.riskScore}/100`, `Агресивність: ${intel.market.marketAggression}/100`, `BTC bias: ${biasUa(intel.market.btcBias)}`].join("\n");
  return [
    ...header,
    `Детектор пампу: ${intel.pump.pumpScore}/100 (${entryTimingUa(intel.pump.entryTiming)})`,
    `Перекіс китів: ${biasUa(intel.whale.whaleBias)} ${intel.whale.smartMoneyScore}/100`,
    `Ліквідації: ${biasUa(intel.liq.sweepDirection)} ${intel.liq.entryQuality}/100`,
    `Режим ринку: ${regimeUaText(intel.market.marketRegime)}, ризик ${intel.market.riskScore}/100`,
    "",
    "Авто-пуші вимкнені для intelligence. Це тільки on-demand меню."
  ].join("\n");
}

function latestIntelligence() {
  const entries = Object.entries(state.intelligence.latestBySymbol);
  if (!entries.length) return null;
  return entries.sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))[0];
}

function fundingText(signal: Signal) {
  const funding = signal.scoreBreakdown.fundingConfirmation ?? 0;
  if (funding >= 70) return "Funding: нормальний";
  if (funding >= 45) return "Funding: помірний";
  return "Funding: перегрітий";
}

function marketModeUa(value: string) {
  return value.replace("Balanced", "збалансований").replace("Conservative", "обережний").replace("Aggressive", "агресивний");
}

function aggressionUa(value: string) {
  if (value === "Balanced") return "збалансована";
  if (value === "Selective fast momentum") return "вибірковий швидкий імпульс";
  if (value === "Conservative") return "обережна";
  return value.toLowerCase();
}

function regimeUaText(value: string) {
  const map: Record<string, string> = {
    TRENDING: "трендовий",
    SIDEWAYS: "боковий",
    BREAKOUT: "пробій",
    REVERSAL: "розворот",
    HIGH_VOLATILITY: "висока волатильність",
    LOW_VOLATILITY: "низька волатильність",
    CHOPPY: "шумний",
    RANGING: "боковий",
    EXPANSION: "розширення",
    COMPRESSION: "стиснення",
    VOLATILE: "волатильний",
    NEWS_DRIVEN: "новинний",
    MANIPULATION_RISK: "ризик маніпуляції"
  };
  return map[value] ?? value.toLowerCase();
}

function biasUa(value: string) {
  return value
    .replace(/bullish/gi, "бичачий")
    .replace(/bearish/gi, "ведмежий")
    .replace(/neutral/gi, "нейтральний")
    .replace(/long/gi, "LONG")
    .replace(/short/gi, "SHORT")
    .replace(/none/gi, "немає")
    .replace(/up/gi, "вгору")
    .replace(/down/gi, "вниз");
}

function entryTimingUa(value: string) {
  return value.replace(/wait/gi, "чекати").replace(/enter/gi, "вхід").replace(/now/gi, "зараз").replace(/retest/gi, "ретест");
}

function intelReasonUa(value: string) {
  return value
    .replace(/momentum/gi, "імпульс")
    .replace(/volume/gi, "обсяг")
    .replace(/breakout/gi, "пробій")
    .replace(/whale/gi, "кити")
    .replace(/liquidation/gi, "ліквідації")
    .replace(/risk/gi, "ризик")
    .replace(/trap/gi, "пастка")
    .replace(/funding/gi, "funding")
    .replace(/market/gi, "ринок")
    .replace(/BTC/gi, "BTC");
}

function fullAnalysisText(pair: string) {
  const signal = findSignal(pair);
  if (!signal) return [`📊 Повний аналіз — ${pair}`, "", "Даних ще немає.", "Натисни 🔄 Оновити або запусти аналіз пари."].join("\n");
  return [
    `📊 Повний аналіз — ${pair}`,
    "",
    signalSummary(signal),
    "",
    `Ймовірність: ${signal.winProbability}%`,
    `Ринок: ${signal.marketRegime}`,
    `BTC: ${signal.btcStable ? "стабільний" : "нестабільний"}`,
    `Risk/Reward: ${signal.riskReward}`,
    "",
    "Причини:",
    ...signal.reasons.slice(0, 6).map((reason) => `• ${reason}`)
  ].join("\n");
}

function isMenuButton(text: string) {
  return buttonAction(text) !== null;
}

type ButtonAction = "menu" | "back" | "signals" | "search_pair" | "watchlist" | "settings" | "signal_pair" | "watch_add" | "watch_remove" | "top" | "signals_refresh" | "positions" | "stats" | "new_tokens" | "watch_status" | "monitoring" | "momentum" | "momentum_scalp" | "momentum_scalp_long" | "momentum_scalp_short" | "momentum_long" | "momentum_short" | "momentum_strongest" | "momentum_check" | "whales" | "whales_accumulation" | "whales_distribution" | "whales_strongest" | "whales_check" | "intelligence" | "pump_detector" | "whale_bias" | "liquidation_status" | "market_regime" | "market" | "btc" | "diagnostics" | "balance" | "leverage" | "x2" | "x3" | "notifications" | "telegram_ux" | "risk_mode" | "conservative" | "balanced" | "aggressive";

function buttonAction(text: string): ButtonAction | null {
  const normalized = normalizeButtonText(text).toLowerCase();
  const stripped = normalized.replace(/[^\p{L}\p{N}₿]+/gu, " ").replace(/\s+/g, " ").trim();
  const aliases: [ButtonAction, string[]][] = [
    ["menu", ["меню", "головне меню", "home", "menu"]],
    ["back", ["назад", "back"]],
    ["signals", ["сигнали", "signals"]],
    ["search_pair", ["search pair", "пошук по парах", "пошук пари", "пошук", "search"]],
    ["watchlist", ["watchlist", "мій список", "список моніторингу"]],
    ["settings", ["налаштування", "settings"]],
    ["signal_pair", ["аналіз пари", "аналіз", "analyze pair", "signal pair"]],
    ["watch_add", ["додати пару", "add pair", "watch add"]],
    ["watch_remove", ["видалити пару", "remove pair", "watch remove"]],
    ["top", ["найкращі сигнали", "топ сетапи", "сетапи", "top", "top setups"]],
    ["signals_refresh", ["оновити сигнали", "refresh signals", "signals refresh"]],
    ["positions", ["активні угоди", "позиції", "оновити позиції", "positions"]],
    ["stats", ["статистика", "stats"]],
    ["new_tokens", ["new tokens", "нові монети"]],
    ["watch_status", ["watch status", "статус моніторингу"]],
    ["monitoring", ["моніторинг", "monitoring"]],
    ["momentum", ["великі рухи", "рухи", "momentum", "moves", "big moves"]],
    ["momentum_scalp", ["scalp", "scalps", "scalp mode", "quick scalp", "швидкий скальп", "скальп", "scalp_mode"]],
    ["momentum_scalp_long", ["scalp long", "scalplong", "лонг скальп", "scalp_long"]],
    ["momentum_scalp_short", ["scalp short", "scalpshort", "шорт скальп", "scalp_short"]],
    ["momentum_long", ["long movers", "лідери long", "лонг рухи", "long momentum"]],
    ["momentum_short", ["short movers", "лідери short", "шорт рухи", "short momentum"]],
    ["momentum_strongest", ["найсильніші рухи", "strongest moves", "strongest momentum"]],
    ["momentum_check", ["перевірити монету", "перевірити рух", "перевірити великий рух", "check momentum", "momentum check"]],
    ["whales", ["рух китів", "кити", "whales", "whale flow"]],
    ["whales_accumulation", ["тільки accumulation", "accumulation", "whales accumulation"]],
    ["whales_distribution", ["тільки distribution", "distribution", "whales distribution"]],
    ["whales_strongest", ["найсильніші рухи", "strongest whale moves", "whales strongest"]],
    ["whales_check", ["перевірити кита", "перевірити whale", "check coin", "whales check"]],
    ["intelligence", ["intelligence", "інтелект"]],
    ["pump_detector", ["pump detector", "pump"]],
    ["whale_bias", ["whale bias", "whale"]],
    ["liquidation_status", ["liquidation status", "liquidation"]],
    ["market_regime", ["market regime", "режим ринку"]],
    ["market", ["ринок", "оновити ринок", "market"]],
    ["btc", ["btc", "btc фільтр", "₿ btc фільтр", "btc filter"]],
    ["diagnostics", ["діагностика", "оновити статус", "diagnostics"]],
    ["balance", ["баланс", "balance"]],
    ["leverage", ["плече", "leverage"]],
    ["x2", ["x2", "2x"]],
    ["x3", ["x3", "3x"]],
    ["notifications", ["сповіщення", "notifications"]],
    ["telegram_ux", ["telegram ux"]],
    ["risk_mode", ["risk mode", "режим ризику"]],
    ["conservative", ["conservative", "обережний"]],
    ["balanced", ["balanced", "збалансований"]],
    ["aggressive", ["aggressive", "агресивний"]]
  ];
  return aliases.find(([, names]) => names.includes(stripped))?.[0] ?? null;
}

function isPairQueryText(text: string) {
  return /^[a-z0-9]{2,30}$/i.test(text);
}

function riskModeFromButton(button: "conservative" | "balanced" | "aggressive"): RiskMode {
  if (button === "aggressive") return "Aggressive";
  if (button === "balanced") return "Balanced";
  return "Conservative";
}

function normalizeButtonText(text: string) {
  return text
    .normalize("NFC")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
