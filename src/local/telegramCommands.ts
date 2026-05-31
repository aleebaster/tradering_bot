import { spawn } from "node:child_process";
import { config } from "./config";
import { state } from "./state";
import { signalQuickActions, TelegramNotifier, type TelegramReplyMarkup } from "./telegram";
import { paperStatsText, setPaperMode } from "./paperTrading";
import { addPriorityPair, loadPriorityWatchlist, normalizePriorityPair, removePriorityPair } from "./watchlistStore";
import type { Signal } from "./types";

type PendingAction = "signal" | "watch" | "unwatch";
type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string } };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number | string } } };
};

export class TelegramCommandCenter {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
  private notifier = new TelegramNotifier();
  private offset = 0;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private pendingAction: PendingAction | null = null;

  start() {
    if (!this.enabled) return;
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
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
      for (const update of json.result ?? []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        if (update.callback_query) {
          const chatId = String(update.callback_query.message?.chat?.id ?? "");
          if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
          await this.handleCallback(update.callback_query.id, update.callback_query.data ?? "");
          continue;
        }
        const chatId = String(update.message?.chat?.id ?? "");
        if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
        const text = update.message?.text?.trim();
        if (text) await this.handle(text);
      }
    } catch {
      // Internet/API outages are expected on laptops. Next poll will retry.
    } finally {
      this.polling = false;
    }
  }

  private async handle(text: string): Promise<void> {
    if (this.pendingAction && !text.startsWith("/") && !isMenuButton(text)) return this.handlePairInput(text);
    const [rawCommand, rawPair] = text.split(/\s+/, 2);
    const command = rawCommand.split("@")[0].toLowerCase();
    const pair = rawPair ? normalizePriorityPair(rawPair) : "";

    if (["/start", "/menu", "/help"].includes(command) || text === "📋 Меню" || text === "🔙 Назад") return this.notifier.send(mainMenuText(), mainMenuKeyboard());
    if (text === "📊 Сигнали") return this.notifier.send(signalMenuText(), signalMenuKeyboard());
    if (text === "👀 Watchlist") return this.notifier.send(watchlistMenuText(), watchlistMenuKeyboard());
    if (text === "⚙️ Налаштування") return this.notifier.send(settingsText(), settingsKeyboard());
    if (text === "🔍 Аналіз пари") return this.askPair("signal");
    if (text === "➕ Додати пару") return this.askPair("watch");
    if (text === "❌ Видалити пару") return this.askPair("unwatch");
    if (text === "🔥 Найкращі сигнали" || text === "🔥 Топ Сетапи") return this.notifier.send(topText(), mainMenuKeyboard());
    if (text === "🟢 Активні угоди" || text === "📂 Позиції") return this.notifier.send(positionsText(), mainMenuKeyboard());
    if (text === "📄 Мій список") return this.notifier.send(watchlistText(), watchlistMenuKeyboard());
    if (text === "🔴 Активувати моніторинг") return this.notifier.send(monitoringText(), watchlistMenuKeyboard());
    if (text === "🟢 Setup Activated") return this.notifier.send(setupActivatedListText(), watchlistMenuKeyboard());
    if (text === "📈 Ринок") return this.notifier.send(marketText(), mainMenuKeyboard());
    if (text === "₿ BTC Фільтр") return this.notifier.send(btcText(), mainMenuKeyboard());
    if (text === "🧪 Діагностика") return this.notifier.send(diagnosticsText(), mainMenuKeyboard());
    if (text === "💰 Баланс (5 USDT)" || text === "⚡ Максимальне плече" || text === "🔔 Сповіщення" || text === "📱 Telegram UX" || text === "🎯 Risk mode") return this.notifier.send(settingsDetailText(text), settingsKeyboard());

    if (command === "/help") return this.notifier.send(helpText(), mainMenuKeyboard());
    if (command === "/status") return this.notifier.send(statusText(), mainMenuKeyboard());
    if (command === "/diagnostics") return this.notifier.send(diagnosticsText(), mainMenuKeyboard());
    if (command === "/market") return this.notifier.send(marketText(), mainMenuKeyboard());
    if (command === "/btc") return this.notifier.send(btcText(), mainMenuKeyboard());
    if (command === "/positions") return this.notifier.send(positionsText(), mainMenuKeyboard());
    if (command === "/top") return this.notifier.send(topText(), mainMenuKeyboard());
    if (command === "/watchlist") return this.notifier.send(watchlistText(), watchlistMenuKeyboard());
    if (command === "/paper") {
      const action = rawPair?.toLowerCase();
      if (action === "on") return this.notifier.send(paperModeText(true));
      if (action === "off") return this.notifier.send(paperModeText(false));
      return this.notifier.send(paperStatsText(), settingsKeyboard());
    }

    if (command === "/watch") {
      if (!pair) return this.askPair("watch");
      const pairs = addPriorityPair(pair);
      return this.notifier.send(["✅ Додано в моніторинг", "", `Моніторинг: ${pair}`, "", "Бот шукатиме найкращу точку входу кожні 10-15 секунд.", "", `Активний watchlist: ${pairs.join(", ")}`].join("\n"), watchlistMenuKeyboard());
    }

    if (command === "/unwatch") {
      if (!pair) return this.askPair("unwatch");
      const pairs = removePriorityPair(pair);
      return this.notifier.send(["✅ Видалено з моніторингу", "", pair, "", pairs.length ? `Активний watchlist: ${pairs.join(", ")}` : "Watchlist порожній"].join("\n"), watchlistMenuKeyboard());
    }

    if (command === "/signal") {
      if (!pair) return this.askPair("signal");
      addPriorityPair(pair);
      startOneShotAnalysis(pair);
      return this.notifier.send(["✅ Аналіз запущено", "", pair, "", "Пара додана в постійний моніторинг.", "Бот повідомить тільки коли з'явиться валідний сетап."].join("\n"), signalQuickActions(pair));
    }

    return this.notifier.send("Невідома дія. Натисни 📋 Меню", mainMenuKeyboard());
  }

  private async askPair(action: PendingAction): Promise<void> {
    this.pendingAction = action;
    const title = action === "signal" ? "аналізу" : action === "watch" ? "додавання" : "видалення";
    return this.notifier.send(["Введіть пару", "", "Приклади:", "BTCUSDT", "ETHUSDT", "SOLUSDT", "AIGENSYNUSDT", "", `Режим: ${title}`].join("\n"), backKeyboard());
  }

  private async handlePairInput(text: string): Promise<void> {
    const action = this.pendingAction;
    this.pendingAction = null;
    const pair = normalizePriorityPair(text);
    if (!pair || pair.length < 6) return this.notifier.send("Пара не розпізнана. Приклад: BTCUSDT", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "unwatch") return this.handle(`/unwatch ${pair}`);
    return this.handle(`/signal ${pair}`);
  }

  private async handleCallback(id: string, data: string): Promise<void> {
    await answerCallback(id);
    const [action, rawSymbol] = data.split(":", 2);
    const pair = normalizePriorityPair(rawSymbol ?? "");
    if (!pair) return this.notifier.send("Пара не розпізнана", mainMenuKeyboard());
    if (action === "watch") return this.handle(`/watch ${pair}`);
    if (action === "refresh") return this.handle(`/signal ${pair}`);
    if (action === "remove") return this.handle(`/unwatch ${pair}`);
    if (action === "full") return this.notifier.send(fullAnalysisText(pair), signalQuickActions(pair));
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
      [{ text: "📊 Сигнали" }, { text: "👀 Watchlist" }],
      [{ text: "📈 Ринок" }, { text: "₿ BTC Фільтр" }],
      [{ text: "🔥 Топ Сетапи" }, { text: "📂 Позиції" }],
      [{ text: "🧪 Діагностика" }, { text: "⚙️ Налаштування" }],
      [{ text: "📋 Меню" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function signalMenuKeyboard(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: "🔍 Аналіз пари" }],
      [{ text: "🔥 Найкращі сигнали" }, { text: "🟢 Активні угоди" }],
      [{ text: "🔙 Назад" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function watchlistMenuKeyboard(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: "➕ Додати пару" }, { text: "📄 Мій список" }],
      [{ text: "❌ Видалити пару" }, { text: "🔴 Активувати моніторинг" }],
      [{ text: "🟢 Setup Activated" }],
      [{ text: "🔙 Назад" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function settingsKeyboard(): TelegramReplyMarkup {
  return {
    keyboard: [
      [{ text: "💰 Баланс (5 USDT)" }, { text: "⚡ Максимальне плече" }],
      [{ text: "🔔 Сповіщення" }, { text: "📱 Telegram UX" }],
      [{ text: "🎯 Risk mode" }],
      [{ text: "🔙 Назад" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function backKeyboard(): TelegramReplyMarkup {
  return { keyboard: [[{ text: "🔙 Назад" }]], resize_keyboard: true, one_time_keyboard: true };
}

function mainMenuText() {
  return [
    "📋 Головне меню",
    "",
    "Обери дію кнопками нижче.",
    "Команди також працюють: /signal, /watch, /top, /market, /btc."
  ].join("\n");
}

function signalMenuText() {
  return ["📊 Сигнали", "", "🔍 Аналіз пари — введи BTCUSDT або іншу пару.", "🔥 Найкращі сигнали — сетапи 85+.", "🟢 Активні угоди — відкриті позиції."].join("\n");
}

function watchlistMenuText() {
  return ["👀 Watchlist", "", "Watchlist зберігається після перезапуску.", "Додай пару, і бот чекатиме валідний setup без спаму."].join("\n");
}

function monitoringText() {
  const pairs = loadPriorityWatchlist();
  return ["🔴 Моніторинг активний", "", "Бот перевіряє watchlist кожні 10-15 секунд.", "Сигнал прийде тільки після підтвердження setup.", "", pairs.length ? `Пари: ${pairs.join(", ")}` : "Watchlist порожній"].join("\n");
}

function setupActivatedListText() {
  const active = state.activeSignals.filter((signal) => signal.entryStatus === "ENTER_NOW" && signal.side !== "NO_TRADE");
  if (!active.length) return "🟢 Setup Activated\n\nЗараз немає активованих setup.";
  return ["🟢 Setup Activated", "", ...active.slice(0, 8).map(signalSummary)].join("\n\n");
}

function settingsText() {
  return ["⚙️ Налаштування", "", "💰 Баланс: 5 USDT", "⚡ Максимальне плече: x5 MAX", "🔔 Сповіщення: увімкнено", "📱 Telegram UX: кнопкове меню", "🎯 Risk mode: малий баланс / контроль ризику"].join("\n");
}

function settingsDetailText(button: string) {
  if (button.startsWith("💰")) return "💰 Баланс\n\nПоточний баланс для розрахунків: 5 USDT";
  if (button.startsWith("⚡")) return "⚡ Максимальне плече\n\nx5 MAX\nРекомендовано: x2-x3";
  if (button.startsWith("🔔")) return "🔔 Сповіщення\n\nУвімкнено тільки якісні сигнали, setup activation та lifecycle alerts.";
  if (button.startsWith("📱")) return "📱 Telegram UX\n\nУвімкнено чисте кнопкове меню, inline quick actions та короткий формат сигналів.";
  return "🎯 Risk mode\n\nФокус: менше сигналів, кращі входи, контроль ризику для малого балансу.";
}

function helpText() {
  return [
    "📌 Команди",
    "",
    "/signal BTCUSDT — аналіз пари + постійний моніторинг",
    "/watch AIGENSYNUSDT — додати в watchlist",
    "/unwatch AIGENSYNUSDT — прибрати з watchlist",
    "/watchlist — список пар",
    "/top — найкращі сетапи зараз",
    "/market — стан ринку",
    "/btc — BTC фільтр",
    "/status — статус сканера",
    "/positions — активні угоди",
    "/paper on — увімкнути paper trading",
    "/paper off — вимкнути paper trading",
    "/paper — статистика paper trading",
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

function positionsText() {
  if (!state.activeSignals.length) return "📦 Активні угоди\n\nНемає активних угод.";
  return ["📂 Позиції", "", ...state.activeSignals.slice(0, 8).map(positionSummary)].join("\n\n");
}

function topText() {
  const top = [...state.activeSignals, ...state.watchlist, ...state.history].filter((signal) => signal.side !== "NO_TRADE" && signal.score >= 80).sort((a, b) => b.score - a.score).slice(0, 5);
  if (!top.length) return "🏆 Топ сетапи\n\nПоки немає валідних сетапів.";
  return ["🔥 Топ Сетапи", "", ...top.map(topLine)].join("\n");
}

function watchlistText() {
  const pairs = loadPriorityWatchlist();
  return ["👁 Watchlist", "", ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["Watchlist порожній"])].join("\n");
}

function signalSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return `${side} ${signal.symbol}\nScore: ${signal.score}/100 · ${signal.entryStatus}\nEntry: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`;
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
  const signal = [...state.activeSignals, ...state.watchlist, ...state.history].find((item) => item.symbol === pair);
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
  return new Set([
    "📊 Сигнали", "👀 Watchlist", "📈 Ринок", "₿ BTC Фільтр", "🔥 Топ Сетапи", "📂 Позиції", "🧪 Діагностика", "⚙️ Налаштування", "📋 Меню", "🔙 Назад",
    "🔍 Аналіз пари", "🔥 Найкращі сигнали", "🟢 Активні угоди", "➕ Додати пару", "📄 Мій список", "❌ Видалити пару", "🔴 Активувати моніторинг", "🟢 Setup Activated",
    "💰 Баланс (5 USDT)", "⚡ Максимальне плече", "🔔 Сповіщення", "📱 Telegram UX", "🎯 Risk mode"
  ]).has(text);
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
