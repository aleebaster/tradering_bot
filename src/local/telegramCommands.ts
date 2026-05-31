import { spawn } from "node:child_process";
import { config } from "./config";
import { state } from "./state";
import { signalQuickActions, TelegramNotifier, type TelegramReplyMarkup } from "./telegram";
import { paperMemoryStatsText, paperStatsText, setPaperMode } from "./paperTrading";
import { addPriorityPair, loadPriorityWatchlist, normalizePriorityPair, removePriorityPair } from "./watchlistStore";
import { loadTelegramSettings, updateTelegramSettings, type MaxLeverage, type RiskMode } from "./telegramSettings";
import { performanceText, tradeStatsText } from "./tradeMemory";
import { learningStatusText, resetLearning } from "./learning";
import { analyzeBybitNewToken, formatNewTokenCard, formatNewTokenWatch, scanBybitNewTokens } from "./newTokenScanner";
import { logger } from "./logger";
import { marketThresholdProfile } from "./scoring";
import type { Signal } from "./types";

type PendingAction = "signal" | "watch" | "unwatch" | "balance" | "newsignal";
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
  private pendingAction: PendingAction | null = null;

  constructor(notifier: TelegramCommandHandler = new TelegramNotifier()) {
    this.notifier = notifier;
  }

  async start() {
    if (!this.enabled) return;
    await this.resetPollingOffset();
    logger.info("Telegram command center started");
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 2500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.polling || !config.TELEGRAM_BOT_TOKEN) return;
    this.polling = true;
    try {
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=1&offset=${this.offset}`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn({ status: res.status, body: await res.text().catch(() => "") }, "Telegram getUpdates failed");
        return;
      }
      const json = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
      for (const update of json.result ?? []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        if (update.callback_query) {
          const chatId = String(update.callback_query.message?.chat?.id ?? "");
          if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
          logger.info({ data: update.callback_query.data }, "Telegram callback received");
          await this.handleCallback(update.callback_query.id, update.callback_query.data ?? "");
          continue;
        }
        const chatId = String(update.message?.chat?.id ?? "");
        if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
        const text = update.message?.text?.trim();
        if (text) {
          logger.info({ text }, "Telegram message received");
          await this.handle(text);
        }
      }
    } catch (err) {
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
      await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: "POST" }).catch(() => undefined);
      this.offset = 0;
      logger.info({ offset: this.offset }, "Telegram polling initialized without discarding pending updates");
    } catch (err) {
      logger.warn({ err }, "Telegram polling offset initialization failed");
    }
  }

  private async handle(text: string): Promise<void> {
    const cleanText = normalizeButtonText(text);
    if (this.pendingAction && !cleanText.startsWith("/") && !isMenuButton(cleanText)) return this.handlePendingInput(cleanText);
    const [rawCommand, rawPair] = cleanText.split(/\s+/, 2);
    const command = rawCommand.split("@")[0].toLowerCase();
    const pair = rawPair ? normalizePriorityPair(rawPair) : "";
    const button = buttonAction(cleanText);

    if (["/start", "/menu"].includes(command) || button === "menu" || button === "back") return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (button === "signals") return this.sendTopSetups();
    if (button === "watchlist") return this.notifier.send(watchlistText(), watchlistActionsKeyboard());
    if (button === "settings") return this.notifier.send(settingsText(), settingsKeyboard());
    if (button === "signal_pair") return this.askPair("signal");
    if (button === "watch_add") return this.askPair("watch");
    if (button === "watch_remove") return this.askPair("unwatch");
    if (button === "top" || button === "signals_refresh") return this.sendTopSetups();
    if (button === "positions") return this.sendPositions();
    if (button === "stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (button === "new_tokens") return this.sendNewTokens();
    if (button === "watch_status") return this.notifier.send(watchStatusText(), watchlistActionsKeyboard());
    if (button === "monitoring") return this.sendMonitoring();
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
    if (command === "/diagnostics") return this.notifier.send(diagnosticsText(), diagnosticsActionsKeyboard());
    if (command === "/market") return this.notifier.send(marketText(), marketActionsKeyboard());
    if (command === "/markethealth") return this.notifier.send(marketHealthText(), marketActionsKeyboard());
    if (command === "/btc") return this.notifier.send(btcText(), marketActionsKeyboard());
    if (command === "/positions") return this.sendPositions();
    if (command === "/stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (command === "/performance") return this.notifier.send(performanceText(), mainMenuKeyboard());
    if (command === "/learning") return this.notifier.send(learningStatusText(), mainMenuKeyboard());
    if (command === "/resetlearning") return this.resetLearningCommand();
    if (command === "/top") return this.sendTopSetups();
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
      return this.notifier.send(["✅ Видалено з моніторингу", "", pair, "", pairs.length ? `Активний watchlist: ${pairs.join(", ")}` : "Watchlist порожній"].join("\n"), watchlistMenuKeyboard());
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
    const title = action === "newsignal" ? "new-token аналізу" : action === "signal" ? "аналізу" : action === "watch" ? "додавання" : "видалення";
    const question = action === "unwatch" ? "Яку пару видалити?" : "Введіть пару:";
    return this.notifier.send([question, "", "Приклади:", "BTCUSDT", "ETHUSDT", "SOLUSDT", "AIGENSYNUSDT", "", `Режим: ${title}`].join("\n"), backKeyboard());
  }

  private async handlePendingInput(text: string): Promise<void> {
    const action = this.pendingAction;
    this.pendingAction = null;
    if (action === "balance") return this.setBalance(text);
    const pair = normalizePriorityPair(text);
    if (!pair || pair.length < 6) return this.notifier.send("Пара не розпізнана. Приклад: BTCUSDT", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "unwatch") return this.handle(`/unwatch ${pair}`);
    if (action === "newsignal") return this.handle(`/newsignal ${pair}`);
    return this.handle(`/signal ${pair}`);
  }

  private async sendNewTokens(): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send("🚀 NEW TOKENS WATCH\n\nТестовий режим: Bybit scan skipped.", signalActionsKeyboard());
    const items = await scanBybitNewTokens(5).catch((error) => {
      logger.warn({ err: error }, "Bybit new token scan failed");
      return [];
    });
    return this.notifier.send(formatNewTokenWatch(items), signalActionsKeyboard());
  }

  private async sendNewSignal(pair: string): Promise<void> {
    if (process.env.TELEGRAM_HANDLER_TEST === "1") return this.notifier.send(`🚀 NEW TOKEN ANALYSIS\n\n${pair}\n\nТестовий режим: Bybit scan skipped.`, signalQuickActions(pair));
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

  private async sendPositions(): Promise<void> {
    if (!state.activeSignals.length) return this.notifier.send("📂 Активних угод немає.", positionsActionsKeyboard());
    await this.notifier.send("📂 Позиції\n\nАктивні угоди:", positionsActionsKeyboard());
    for (const signal of state.activeSignals.slice(0, 8)) await this.notifier.send(positionSummary(signal), signalQuickActions(signal.symbol));
  }

  private async sendMonitoring(): Promise<void> {
    const pairs = loadPriorityWatchlist();
    if (!pairs.length) return this.notifier.send("👀 Моніторинг\n\nWatchlist порожній. Натисни ➕ Додати пару.", watchlistActionsKeyboard());
      await this.notifier.send("👀 Моніторинг активний\n\n⏱ Watchlist evolution: перевірка кожні 2 хв", watchlistActionsKeyboard());
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
    return this.notifier.send(["✅ Risk mode оновлено", "", `Поточний режим: ${settings.riskMode}`].join("\n"), settingsKeyboard());
  }

  private async resetLearningCommand(): Promise<void> {
    resetLearning();
    return this.notifier.send(["✅ Learning reset", "", "Adaptive weights restored to defaults.", "Safe learning will restart after 20 completed trades."].join("\n"), mainMenuKeyboard());
  }

  private async handleCallback(id: string, data: string, answer = true): Promise<void> {
    if (answer) await answerCallback(id);
    const [action, rawSymbol] = data.split(":", 2);
    if (action === "ui") return this.handleUiCallback(rawSymbol ?? "");
    const pair = normalizePriorityPair(rawSymbol ?? "");
    if (!pair) return this.notifier.send("Пара не розпізнана", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "refresh") return this.handle(`/signal ${pair}`);
    if (action === "remove") return this.handle(`/unwatch ${pair}`);
    if (action === "full") return this.notifier.send(fullAnalysisText(pair), signalQuickActions(pair));
  }

  private async handleUiCallback(action: string): Promise<void> {
    const button = buttonAction(action);
    if (!button) return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (button === "menu" || button === "back") return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (button === "signals") return this.sendTopSetups();
    if (button === "watchlist") return this.notifier.send(watchlistText(), watchlistActionsKeyboard());
    if (button === "settings") return this.notifier.send(settingsText(), settingsKeyboard());
    if (button === "signal_pair") return this.askPair("signal");
    if (button === "watch_add") return this.askPair("watch");
    if (button === "watch_remove") return this.askPair("unwatch");
    if (button === "top" || button === "signals_refresh") return this.sendTopSetups();
    if (button === "positions") return this.sendPositions();
    if (button === "stats") return this.notifier.send(tradeStatsText(), mainMenuKeyboard());
    if (button === "new_tokens") return this.sendNewTokens();
    if (button === "watch_status") return this.notifier.send(watchStatusText(), watchlistActionsKeyboard());
    if (button === "monitoring") return this.sendMonitoring();
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
}

async function answerCallback(callbackQueryId: string) {
  if (!config.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  }).catch(() => undefined);
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
    inline_keyboard: [
      [uiButton("📊 Сигнали", "signals"), uiButton("👀 Watchlist", "watchlist")],
      [uiButton("📈 Ринок", "market"), uiButton("₿ BTC Фільтр", "btc")],
      [uiButton("🔥 Топ Сетапи", "top"), uiButton("📂 Позиції", "positions")],
      [uiButton("🪙 New Tokens", "new_tokens"), uiButton("📊 Статистика", "stats")],
      [uiButton("🧪 Діагностика", "diagnostics"), uiButton("⚙️ Налаштування", "settings")]
    ]
  };
}

function signalMenuKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔍 Аналіз пари", "signal_pair")],
      [uiButton("🪙 New Tokens", "new_tokens")],
      [uiButton("🔥 Найкращі сигнали", "top"), uiButton("🟢 Активні угоди", "positions")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function watchlistMenuKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("➕ Додати пару", "watch_add"), uiButton("📄 Мій список", "watchlist")],
      [uiButton("👀 Watch status", "watch_status")],
      [uiButton("❌ Видалити пару", "watch_remove"), uiButton("🔴 Моніторинг", "monitoring")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function signalActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Сигнали", "signals_refresh"), uiButton("🔍 Аналіз пари", "signal_pair")],
      [uiButton("🔥 Топ Сетапи", "top"), uiButton("📂 Позиції", "positions")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function marketActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Ринок", "market")],
      [uiButton("📊 Сигнали", "signals"), uiButton("🔥 Топ Сетапи", "top")],
      [uiButton("₿ BTC Фільтр", "btc"), uiButton("🔙 Назад", "back")]
    ]
  };
}

function watchlistActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("📄 Мій список", "watchlist"), uiButton("👀 Watch status", "watch_status")],
      [uiButton("🔴 Моніторинг", "monitoring")],
      [uiButton("➕ Додати пару", "watch_add"), uiButton("❌ Видалити пару", "watch_remove")],
      [uiButton("📊 Аналіз", "signal_pair"), uiButton("🔙 Назад", "back")]
    ]
  };
}

function positionsActionsKeyboard(): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("🔄 Оновити Позиції", "positions"), uiButton("🔥 Топ Сетапи", "top")],
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

function watchlistQuickKeyboard(_pair: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [uiButton("📄 Мій список", "watchlist"), uiButton("👀 Watch status", "watch_status")],
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
      [uiButton("🎯 Risk mode", "risk_mode")],
      [uiButton("🔙 Назад", "back")]
    ]
  };
}

function leverageKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("x2", "x2"), uiButton("x3", "x3")], [uiButton("🔙 Назад", "back")]] };
}

function riskModeKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("Conservative", "conservative"), uiButton("Balanced", "balanced")], [uiButton("Aggressive", "aggressive")], [uiButton("🔙 Назад", "back")]] };
}

function backKeyboard(): TelegramReplyMarkup {
  return { inline_keyboard: [[uiButton("🔙 Назад", "back")]] };
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

function signalMenuText() {
  return topText();
}

function watchlistMenuText() {
  return watchlistText();
}

function monitoringText() {
  const pairs = loadPriorityWatchlist();
  if (!pairs.length) return "👀 Моніторинг\n\nWatchlist порожній. Натисни ➕ Додати пару.";
  return ["👀 Моніторинг активний", "", ...pairs.map(monitoringStatusFor)].join("\n\n");
}

function settingsText() {
  const settings = loadTelegramSettings();
  return ["⚙️ Налаштування", "", `💰 Баланс: ${settings.balanceUsdt} USDT`, `⚡ Плече: ${settings.maxLeverage} MAX`, `🔔 Сповіщення: ${settings.notifications ? "ON" : "OFF"}`, "📱 Telegram UX: кнопкове меню", `🎯 Risk mode: ${settings.riskMode}`].join("\n");
}

function settingsDetailText(button: string) {
  const settings = loadTelegramSettings();
  if (button.startsWith("🔔")) return "🔔 Сповіщення\n\nАвто-пуші: тільки real entry, watchlist → entry upgrade та trade management.";
  if (button.startsWith("📱")) return "📱 Telegram UX\n\nУвімкнено чисте кнопкове меню, inline quick actions та короткий формат сигналів.";
  return `⚙️ Налаштування\n\nБаланс: ${settings.balanceUsdt} USDT\nПлече: ${settings.maxLeverage}\nСповіщення: ${settings.notifications ? "ON" : "OFF"}\nRisk mode: ${settings.riskMode}`;
}

function leverageText() {
  return ["⚡ Плече", "", `Поточний ліміт: ${loadTelegramSettings().maxLeverage}`, "", "Обери максимальне плече:", "x2", "x3"].join("\n");
}

function riskModeText() {
  return ["🎯 Risk mode", "", `Поточний режим: ${loadTelegramSettings().riskMode}`, "", "Conservative — найменший ризик", "Balanced — стандартний ризик", "Aggressive — більше ризику тільки для сильних setup"].join("\n");
}

function helpText() {
  return [
    "📌 Команди",
    "",
    "/signal BTCUSDT — аналіз пари + постійний моніторинг",
    "/watch AIGENSYNUSDT — додати в watchlist",
    "/unwatch AIGENSYNUSDT — прибрати з watchlist",
    "/watchlist — список пар",
    "/watchstatus — активні setup, score, missing confirmations",
    "/top — найкращі сетапи зараз",
    "/newtokens — Bybit Futures new-token watch",
    "/newsignal TOKENUSDT — аналіз нового futures токена",
    "/newwatch — якісні нові лістинги під моніторингом",
    "/market — стан ринку",
    "/markethealth — режим, агресивність і активні пороги",
    "/btc — BTC фільтр",
    "/status — статус сканера",
    "/positions — активні угоди",
    "/stats — journal статистика",
    "/performance — real strategy performance",
    "/learning — safe learning статус",
    "/resetlearning — скинути adaptive weights",
    "/paper on — увімкнути paper trading",
    "/paper off — вимкнути paper trading",
    "/paper — статистика paper trading",
    "/paperstats — watchlist simulation stats",
    "/diagnostics — API і біржі",
    "/help — список команд"
  ].join("\n");
}

function paperModeText(enabled: boolean) {
  setPaperMode(enabled);
  return [enabled ? "✅ Paper trading ON" : "⏸ Paper trading OFF", "", paperStatsText()].join("\n");
}

function statusText() {
  return [
    "🟢 Статус сканера",
    "",
    `Режим: ${state.diagnostics.mode}`,
    `Останній scan: ${state.diagnostics.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "очікується"}`,
    `Символів: ${state.diagnostics.scannedSymbols}`,
    `Сигналів сьогодні: ${state.stats.signalsToday}`,
    `Watchlist: ${loadPriorityWatchlist().join(", ") || "порожній"}`
  ].join("\n");
}

function diagnosticsText() {
  const api = Object.entries(state.diagnostics.apiStatus).map(([key, value]) => `${key}: ${value}`);
  const errors = Object.entries(state.diagnostics.authErrors).map(([key, value]) => `${key}: ${value}`);
  const bybit = state.diagnostics.apiStatus.bybit === "ok" || !state.diagnostics.authErrors.bybit;
  return [
    "🧪 Діагностика",
    "",
    `${bybit ? "✅" : "⚠️"} Bybit connected`,
    `${config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID ? "✅" : "⚠️"} Telegram connected`,
    "✅ Dashboard online",
    `${loadPriorityWatchlist().length ? "✅" : "⚠️"} Watchlist active`,
    `${state.diagnostics.lastScanAt ? "✅" : "⚠️"} Scanner active`,
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
    "🩺 Market Health",
    "",
    `Market: ${thresholds.mode}`,
    `BTC: ${btcOk ? "stable" : "unstable"}`,
    `Volatility: ${regime}`,
    `Aggression: ${thresholds.aggression}`,
    `Active thresholds: Entry ${thresholds.entry}+ / Watchlist ${thresholds.watch}+ / Early ${thresholds.early}+`,
    "",
    `Expected signals: ${expectedSignals(thresholds.aggression, btcOk)}`,
    `Recent flow: ${entries} entries / ${watch} watchlist / ${noTrade} no-trade`,
    `Average score: ${avgScore || "немає даних"}`,
    "",
    "Why signals are low/high:",
    ...marketHealthReasons(recent, btcOk, thresholds.aggression)
  ].join("\n");
}

function expectedSignals(aggression: string, btcOk: boolean) {
  if (!btcOk) return "Low";
  if (aggression === "Balanced") return "Normal: 1-2 entries, 4-6 watchlist per 20 checks";
  if (aggression === "Selective fast momentum") return "Medium: fast clean setups only";
  return "Low";
}

function marketHealthReasons(recent: Signal[], btcOk: boolean, aggression: string) {
  const reasons: string[] = [];
  if (!btcOk) reasons.push("⚠️ BTC stability filter limits alt entries");
  if (aggression === "Conservative") reasons.push("⚠️ Sideways/weak regime keeps strict 92+ entry threshold");
  const weakVolume = recent.filter((signal) => (signal.scoreBreakdown.volumeConfirmation ?? 0) < 65).length;
  const weakSniper = recent.filter((signal) => (signal.scoreBreakdown.entrySniper ?? 0) < 70).length;
  const fakeRisk = recent.filter((signal) => signal.fakeBreakout?.risk).length;
  if (weakVolume >= Math.max(3, recent.length / 3)) reasons.push("⚠️ Volume confirmation is low across recent scans");
  if (weakSniper >= Math.max(3, recent.length / 3)) reasons.push("⚠️ Sniper/retest trigger is not ready on most setups");
  if (fakeRisk) reasons.push("⚠️ Fake-breakout protection is active");
  if (!reasons.length) reasons.push("✅ Market filters are healthy; scanner can upgrade watchlist quickly");
  return reasons.slice(0, 5);
}

function positionsText() {
  if (!state.activeSignals.length) return "📂 Активних угод немає.";
  return ["📂 Позиції", "", ...state.activeSignals.slice(0, 8).map(positionSummary)].join("\n\n");
}

function topText() {
  const top = topSignals();
  if (!top.length) return ["📊 Сигнали / 🔥 Топ Сетапи", "", "Активних entry/watchlist setup зараз немає.", "", marketText()].join("\n");
  return ["📊 Сигнали / 🔥 Топ Сетапи", "", ...top.map(topLine)].join("\n");
}

function topSignals() {
  return [...state.activeSignals, ...state.watchlist, ...state.history].filter((signal) => signal.side !== "NO_TRADE" && signal.score >= 72).sort((a, b) => b.score - a.score).slice(0, 5);
}

function watchlistText() {
  const pairs = loadPriorityWatchlist();
  const ranked = rankedWatchlist();
  return [
    "👀 Watchlist / ТОП WATCHLIST",
    "",
    ...(ranked.length ? ranked.slice(0, 10).map((signal, index) => `#${index + 1} ${signal.symbol} — ${signal.score}/100`) : ["Активних setup 72+ поки немає"]),
    "",
    "Priority pairs:",
    ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["Watchlist порожній"])
  ].join("\n");
}

function watchStatusText() {
  const ranked = rankedWatchlist();
  if (!ranked.length) return ["👀 Watch status", "", "Активних setup 72+ зараз немає.", "Scanner продовжує моніторинг без FOMO."].join("\n");
  return ["👀 Watchlist / ТОП WATCHLIST", "", ...ranked.slice(0, 8).map(watchStatusCard)].join("\n\n");
}

function rankedWatchlist() {
  return state.watchlist
    .filter((signal) => signal.mode === "futures" && signal.score >= 72)
    .sort((a, b) => readinessScore(b) - readinessScore(a));
}

function watchStatusCard(signal: Signal, index: number) {
  const missing = missingWatchConfirmations(signal);
  return [
    `#${index + 1} ${signal.symbol}`,
    "",
    `${signal.score}/100`,
    "",
    "Readiness:",
    `${readinessPercent(signal)}%`,
    "",
    "Missing confirmations:",
    ...(missing.length ? missing.map((item) => `⚠️ ${item}`) : ["✅ entry trigger nearly ready"]),
    "",
    "Estimated trigger:",
    readinessLabel(signal)
  ].join("\n");
}

function missingWatchConfirmations(signal: Signal) {
  const missing: string[] = [];
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) < 70) missing.push("retest / liquidity sweep");
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) missing.push("volume confirmation");
  if ((signal.scoreBreakdown.openInterestConfirmation ?? 0) < 58) missing.push("OI rising");
  if ((signal.scoreBreakdown.momentumQuality ?? 0) < 70) missing.push("momentum shift");
  if ((signal.scoreBreakdown.orderBookImbalance ?? 0) < 60) missing.push("orderbook improvement");
  if ((signal.scoreBreakdown.entrySniper ?? 0) < 70) missing.push("sniper trigger");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") missing.push("BTC stable");
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
  if (signal.score >= 88 && missing <= 2) return "HIGH";
  if (signal.score >= 82 && missing <= 4) return "MEDIUM";
  return "EARLY";
}

function signalAnalysisText(pair: string) {
  const signal = findSignal(pair);
  if (!signal) return ["🔍 Аналіз запущено", "", pair, "", "Пара додана в постійний моніторинг.", "Live scanner перевіряє Bybit і поверне setup після підтвердження.", "", monitoringStatusFor(pair)].join("\n");
  return compactSignalCard(signal);
}

function watchAddedText(pair: string) {
  return [
    `✅ ${pair} додано до Watchlist`,
    "",
    "👀 Моніторинг активний",
    "⏱ Evolution check кожні 2 хв",
    "",
    monitoringStatusFor(pair)
  ].join("\n");
}

function monitoringStatusFor(pair: string) {
  const signal = findSignal(pair);
  if (!signal) return [pair, "", "Статус:", "Дані scanner ще формуються"].join("\n");
  const side = signal.side === "WATCHLIST" ? `INTERNAL MONITOR ${signal.score}/100` : signal.side === "NO_TRADE" ? "NO ACTIVE ENTRY" : `${signal.side} ${signal.score}%`;
  return [pair, "", "Статус:", side, "", signal.side === "WATCHLIST" ? `Readiness: ${readinessLabel(signal)}` : signal.management].join("\n");
}

function findSignal(pair: string) {
  return [...state.activeSignals, ...state.watchlist, ...state.history].find((item) => item.symbol === pair);
}

function signalSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return `${side} ${signal.symbol}\nScore: ${signal.score}/100 · ${signal.entryStatus}\nEntry: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`;
}

function compactSignalCard(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  const icon = side === "SHORT" ? "🔴" : side === "WATCHLIST" ? "⚠️" : "🟢";
  return [
    `${icon} ${side} — ${signal.symbol}`,
    "",
    signal.entryStatus === "ENTER_NOW" ? "✅ REAL ENTRY" : side === "WATCHLIST" ? "INTERNAL MONITOR" : "NO ACTIVE ENTRY",
    "",
    `Score: ${signal.score}%`,
    `Entry: ${fmt(signal.entry[0])}-${fmt(signal.entry[1])}`,
    `SL: ${fmt(signal.stopLoss)}`,
    `TP: ${signal.takeProfit.map(fmt).join(" / ")}`,
    "",
    signal.side === "WATCHLIST" ? `Readiness: ${readinessLabel(signal)}` : signal.management
  ].join("\n");
}

function topLine(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  const icon = side === "SHORT" ? "🔴" : side === "WATCHLIST" ? "⚠️" : "🟢";
  return `${icon} ${side} ${signal.symbol} — ${signal.score}%`;
}

function positionSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return [
    `${side} ${signal.symbol} — ${signal.score}%`,
    `Entry: ${fmt(signal.entry[0])}-${fmt(signal.entry[1])}`,
    `SL: ${fmt(signal.stopLoss)}`,
    `TP: ${signal.takeProfit.map(fmt).join(" / ")}`,
    "Breakeven: після TP1",
    `Status: ${signal.entryStatus}`
  ].join("\n");
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
    latest ? fundingText(latest) : "Немає даних",
    "",
    "Risk:",
    latest && latest.newsRisk.severity !== "HIGH" ? "Низький" : "Підвищений"
  ].join("\n");
}

function fundingText(signal: Signal) {
  const funding = signal.scoreBreakdown.fundingConfirmation ?? 0;
  if (funding >= 70) return "Нормальний";
  if (funding >= 45) return "Помірний";
  return "Перегрітий";
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

type ButtonAction = "menu" | "back" | "signals" | "watchlist" | "settings" | "signal_pair" | "watch_add" | "watch_remove" | "top" | "signals_refresh" | "positions" | "stats" | "new_tokens" | "watch_status" | "monitoring" | "market" | "btc" | "diagnostics" | "balance" | "leverage" | "x2" | "x3" | "notifications" | "telegram_ux" | "risk_mode" | "conservative" | "balanced" | "aggressive";

function buttonAction(text: string): ButtonAction | null {
  const normalized = normalizeButtonText(text).toLowerCase();
  const stripped = normalized.replace(/[^\p{L}\p{N}₿]+/gu, " ").replace(/\s+/g, " ").trim();
  const aliases: [ButtonAction, string[]][] = [
    ["menu", ["меню", "menu"]],
    ["back", ["назад", "back"]],
    ["signals", ["сигнали", "signals"]],
    ["watchlist", ["watchlist", "мій список"]],
    ["settings", ["налаштування", "settings"]],
    ["signal_pair", ["аналіз пари", "аналіз", "analyze pair", "signal pair"]],
    ["watch_add", ["додати пару", "add pair", "watch add"]],
    ["watch_remove", ["видалити пару", "remove pair", "watch remove"]],
    ["top", ["найкращі сигнали", "топ сетапи", "top setups"]],
    ["signals_refresh", ["оновити сигнали", "refresh signals", "signals refresh"]],
    ["positions", ["активні угоди", "позиції", "оновити позиції", "positions"]],
    ["stats", ["статистика", "stats"]],
    ["new_tokens", ["new tokens"]],
    ["watch_status", ["watch status"]],
    ["monitoring", ["моніторинг", "monitoring"]],
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
    ["conservative", ["conservative"]],
    ["balanced", ["balanced"]],
    ["aggressive", ["aggressive"]]
  ];
  return aliases.find(([, names]) => names.includes(stripped))?.[0] ?? null;
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
