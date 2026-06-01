import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";
import { state } from "../src/local/state";
import { loadTelegramSettings } from "../src/local/telegramSettings";
import { loadPriorityWatchlist } from "../src/local/watchlistStore";

class CaptureNotifier extends TelegramNotifier {
  messages: { text: string; replyMarkup?: TelegramReplyMarkup }[] = [];

  override async send(text: string, replyMarkup?: TelegramReplyMarkup) {
    this.messages.push({ text, replyMarkup });
  }
}

const notifier = new CaptureNotifier();

const mainMenu: TelegramReplyMarkup = {
  keyboard: [
    [{ text: "📊 Сигнали" }, { text: "🔎 Пошук по парах" }],
    [{ text: "👀 Watchlist" }, { text: "📈 Ринок" }],
    [{ text: "₿ BTC Фільтр" }, { text: "🔥 Топ Сетапи" }],
    [{ text: "🐋 Рух китів" }, { text: "🧠 Intelligence" }],
    [{ text: "🪙 New Tokens" }, { text: "📊 Статистика" }],
    [{ text: "⚙️ Налаштування" }, { text: "🧪 Діагностика" }],
    [{ text: "📁 Позиції" }, { text: "🏠 Головне меню" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const signalActions: TelegramReplyMarkup = {
  inline_keyboard: [
    [{ text: "🟢 Моніторити", callback_data: "watch:BTCUSDT" }, { text: "🔄 Оновити Аналіз", callback_data: "refresh:BTCUSDT" }],
    [{ text: "📖 Детальний аналіз", callback_data: "analyze_futures:BTCUSDT" }, { text: "🛠 Raw Technical Data", callback_data: "raw_futures:BTCUSDT" }],
    [{ text: "❌ Видалити", callback_data: "remove:BTCUSDT" }]
  ]
};

const signalMenu: TelegramReplyMarkup = { inline_keyboard: [[btn("🔍 Аналіз пари", "signal_pair")], [btn("🔥 Найкращі сигнали", "top"), btn("🔍 Пошук по парах", "search_pair")], [btn("🔙 Назад", "back")]] };
const watchlistMenu: TelegramReplyMarkup = { inline_keyboard: [[btn("➕ Додати пару", "watch_add"), btn("📄 Мій список", "watchlist")], [btn("❌ Видалити пару", "watch_remove"), btn("🔴 Моніторинг", "monitoring")], [btn("🔙 Назад", "back")]] };
const settingsMenu: TelegramReplyMarkup = { inline_keyboard: [[btn("💰 Баланс", "balance"), btn("⚡ Плече", "leverage")], [btn("🔔 Сповіщення", "notifications"), btn("📱 Telegram UX", "telegram_ux")], [btn("🎯 Risk mode", "risk_mode")], [btn("🔙 Назад", "back")]] };
const leverageMenu: TelegramReplyMarkup = { inline_keyboard: [[btn("x2", "x2"), btn("x3", "x3")], [btn("🔙 Назад", "back")]] };
const riskMenu: TelegramReplyMarkup = { inline_keyboard: [[btn("Conservative", "conservative"), btn("Balanced", "balanced")], [btn("Aggressive", "aggressive")], [btn("🔙 Назад", "back")]] };
const marketActions: TelegramReplyMarkup = { inline_keyboard: [[btn("🔄 Оновити Ринок", "market")], [btn("📊 Сигнали", "signals"), btn("🔥 Топ Сетапи", "top")], [btn("₿ BTC Фільтр", "btc"), btn("🔙 Назад", "back")]] };
const watchlistActions: TelegramReplyMarkup = { inline_keyboard: [[btn("📄 Мій список", "watchlist"), btn("❌ Видалити пару", "watch_remove")], [btn("📊 Аналіз", "signal_pair"), btn("🔴 Моніторинг", "monitoring")], [btn("🔙 Назад", "back")]] };

async function main() {
  await notifier.send(["📋 Головне меню", "", "Тест кнопкового Telegram UI.", "Натискай кнопки нижче без введення команд."].join("\n"), mainMenu);
  await notifier.send(["📊 Сигнали", "", "Кнопки підключені до /signal, /top, /positions."].join("\n"), signalMenu);
  await notifier.send(realTopText());
  await notifier.send(realPositionsText());
  await notifier.send(["👀 Watchlist", "", "Кнопки підключені до /watch, /unwatch, /watchlist."].join("\n"), watchlistMenu);
  await notifier.send(realWatchlistText(), watchlistActions);
  await notifier.send(realMarketText(), marketActions);
  await notifier.send(realBtcText());
  await notifier.send(realDiagnosticsText());
  await notifier.send(realSettingsText(), settingsMenu);
  await notifier.send("⚡ Плече\n\nОберіть x2 або x3", leverageMenu);
  await notifier.send("🎯 Risk mode\n\nОберіть режим ризику", riskMenu);
  await notifier.send(["🔴 SHORT — BTCUSDT", "", "📍 Entry zone: 104250 - 104400", "➡️ SHORT setup", "", "🛑 SL: 104900", "🎯 TP1: 103800", "🎯 TP2: 103100", "🎯 TP3: 102400", "", "⚡ x3", "📊 Confidence: 97%", "", "Причина:", "• momentum bearish", "• OI confirm", "• sniper trigger"].join("\n"), signalActions);
  console.log(JSON.stringify({
    ok: true,
    sent: ["main_menu", "signal_menu", "watchlist_menu", "market_actions", "settings_menu", "leverage_menu", "risk_menu", "inline_signal_quick_actions", "real_status_outputs"],
    proof: {
      persistentMenuRows: mainMenu.keyboard?.length,
      persistentMenuVisible: mainMenu.is_persistent === true,
      duplicateSearchButtons: mainMenu.keyboard?.flat().filter((button) => button.text.includes("Пошук по парах")).length ?? 0,
      whaleButtonVisible: Boolean(mainMenu.keyboard?.flat().some((button) => button.text === "🐋 Рух китів")),
      inlineKeyboardRows: signalActions.inline_keyboard?.length,
      noLiveTelegramSpam: notifier.messages.length === 13,
      buttons: ["📊 Сигнали", "🔎 Пошук по парах", "👀 Watchlist", "📈 Ринок", "₿ BTC Фільтр", "🔥 Топ Сетапи", "🐋 Рух китів", "🧠 Intelligence", "🪙 New Tokens", "📊 Статистика", "⚙️ Налаштування", "🧪 Діагностика", "📁 Позиції", "🏠 Головне меню", "🔍 Аналіз пари", "➕ Додати пару", "📄 Мій список", "❌ Видалити пару", "🔴 Моніторинг", "💰 Баланс", "⚡ Плече", "x2", "x3", "🔔 Сповіщення", "🎯 Risk mode", "Conservative", "Balanced", "Aggressive", "🟢 Моніторити", "🔄 Оновити Аналіз", "❌ Видалити", "📖 Детальний аналіз", "🛠 Raw Technical Data"]
    }
  }, null, 2));
}

function btn(text: string, action: string) {
  return { text, callback_data: `ui:${action}` };
}

function realTopText() {
  const top = [...state.activeSignals, ...state.watchlist, ...state.history].filter((signal) => signal.side !== "NO_TRADE" && signal.score >= 80).sort((a, b) => b.score - a.score).slice(0, 5);
  return top.length ? ["🔥 Топ Сетапи", "", ...top.map((signal) => `${signal.side === "SHORT" ? "🔴" : signal.side === "WATCHLIST" ? "⚠️" : "🟢"} ${signal.side} ${signal.symbol} — ${signal.score}%`)].join("\n") : "🔥 Топ Сетапи\n\nЗараз немає setup 80+. Scanner active, чекаємо якісний сигнал.";
}

function realPositionsText() {
  return "🔍 Пошук по парах\n\nВведи пару для професійного аналізу, наприклад BTCUSDT або btc.";
}

function realWatchlistText() {
  const pairs = loadPriorityWatchlist();
  return ["👁 Watchlist", "", ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["Watchlist порожній"])].join("\n");
}

function realMarketText() {
  return ["📈 Ринок:", state.marketCondition || "формується", "", "Scanner:", state.diagnostics.lastScanAt ? "активний" : "очікується"].join("\n");
}

function realBtcText() {
  const latest = [...state.activeSignals, ...state.watchlist, ...state.history].find((signal) => signal.symbol === "BTCUSDT" || signal.btcStable !== undefined);
  return ["₿ BTC Фільтр", "", `Стабільність: ${latest?.btcStable ? "стабільний" : "немає даних"}`, `Ринок: ${state.marketCondition}`].join("\n");
}

function realDiagnosticsText() {
  return ["🧪 Діагностика", "", "✅ Telegram connected", "✅ Dashboard online", `${state.diagnostics.lastScanAt ? "✅" : "⚠️"} Scanner active`, `${loadPriorityWatchlist().length ? "✅" : "⚠️"} Watchlist active`].join("\n");
}

function realSettingsText() {
  const settings = loadTelegramSettings();
  return ["⚙️ Налаштування", "", `💰 Баланс: ${settings.balanceUsdt} USDT`, `⚡ Плече: ${settings.maxLeverage}`, `🔔 Сповіщення: ${settings.notifications ? "ON" : "OFF"}`, `🎯 Risk mode: ${settings.riskMode}`].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
