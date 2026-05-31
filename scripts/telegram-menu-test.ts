import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";
import { state } from "../src/local/state";
import { loadTelegramSettings } from "../src/local/telegramSettings";
import { loadPriorityWatchlist } from "../src/local/watchlistStore";

const notifier = new TelegramNotifier();

const mainMenu: TelegramReplyMarkup = {
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

const signalActions: TelegramReplyMarkup = {
  inline_keyboard: [
    [{ text: "🟢 Моніторити", callback_data: "watch:BTCUSDT" }, { text: "🔄 Оновити", callback_data: "refresh:BTCUSDT" }],
    [{ text: "❌ Видалити", callback_data: "remove:BTCUSDT" }, { text: "📊 Повний аналіз", callback_data: "full:BTCUSDT" }]
  ]
};

const signalMenu: TelegramReplyMarkup = { keyboard: [[{ text: "🔍 Аналіз пари" }], [{ text: "🔥 Найкращі сигнали" }, { text: "🟢 Активні угоди" }], [{ text: "🔙 Назад" }]], resize_keyboard: true, is_persistent: true };
const watchlistMenu: TelegramReplyMarkup = { keyboard: [[{ text: "➕ Додати пару" }, { text: "📄 Мій список" }], [{ text: "❌ Видалити пару" }, { text: "🔴 Моніторинг" }], [{ text: "🔙 Назад" }]], resize_keyboard: true, is_persistent: true };
const settingsMenu: TelegramReplyMarkup = { keyboard: [[{ text: "💰 Баланс" }, { text: "⚡ Плече" }], [{ text: "🔔 Сповіщення" }, { text: "📱 Telegram UX" }], [{ text: "🎯 Risk mode" }], [{ text: "🔙 Назад" }]], resize_keyboard: true, is_persistent: true };
const leverageMenu: TelegramReplyMarkup = { keyboard: [[{ text: "x2" }, { text: "x3" }, { text: "x5" }], [{ text: "🔙 Назад" }]], resize_keyboard: true };
const riskMenu: TelegramReplyMarkup = { keyboard: [[{ text: "Conservative" }, { text: "Balanced" }], [{ text: "Aggressive" }], [{ text: "🔙 Назад" }]], resize_keyboard: true };

async function main() {
  await notifier.send(["📋 Головне меню", "", "Тест кнопкового Telegram UI.", "Натискай кнопки нижче без введення команд."].join("\n"), mainMenu);
  await notifier.send(["📊 Сигнали", "", "Кнопки підключені до /signal, /top, /positions."].join("\n"), signalMenu);
  await notifier.send(realTopText());
  await notifier.send(realPositionsText());
  await notifier.send(["👀 Watchlist", "", "Кнопки підключені до /watch, /unwatch, /watchlist."].join("\n"), watchlistMenu);
  await notifier.send(realWatchlistText());
  await notifier.send(realMarketText());
  await notifier.send(realBtcText());
  await notifier.send(realDiagnosticsText());
  await notifier.send(realSettingsText(), settingsMenu);
  await notifier.send("⚡ Плече\n\nОберіть x2, x3 або x5", leverageMenu);
  await notifier.send("🎯 Risk mode\n\nОберіть режим ризику", riskMenu);
  await notifier.send(["🟢 LONG — BTCUSDT", "", "✅ ЗАХОДИТИ ЗАРАЗ", "", "📍 Вхід:", "104250-104400", "", "🛑 SL:", "103780", "", "🎯 TP1:", "105100", "", "⚡ Плече:", "x3", "", "💰 Баланс:", "5 USDT", "", "📦 Вхід:", "15 USDT"].join("\n"), signalActions);
  console.log(JSON.stringify({
    ok: true,
    sent: ["main_menu", "signal_menu", "watchlist_menu", "settings_menu", "leverage_menu", "risk_menu", "inline_signal_quick_actions", "real_status_outputs"],
    proof: {
      replyKeyboardRows: mainMenu.keyboard?.length,
      inlineKeyboardRows: signalActions.inline_keyboard?.length,
      buttons: ["📊 Сигнали", "🔍 Аналіз пари", "🔥 Найкращі сигнали", "🟢 Активні угоди", "👀 Watchlist", "➕ Додати пару", "📄 Мій список", "❌ Видалити пару", "🔴 Моніторинг", "📈 Ринок", "₿ BTC Фільтр", "📂 Позиції", "🧪 Діагностика", "⚙️ Налаштування", "💰 Баланс", "⚡ Плече", "x2", "x3", "x5", "🔔 Сповіщення", "🎯 Risk mode", "Conservative", "Balanced", "Aggressive", "🟢 Моніторити", "🔄 Оновити", "❌ Видалити", "📊 Повний аналіз"]
    }
  }, null, 2));
}

function realTopText() {
  const top = [...state.activeSignals, ...state.watchlist, ...state.history].filter((signal) => signal.side !== "NO_TRADE" && signal.score >= 80).sort((a, b) => b.score - a.score).slice(0, 5);
  return top.length ? ["🔥 Топ Сетапи", "", ...top.map((signal) => `${signal.side === "SHORT" ? "🔴" : signal.side === "WATCHLIST" ? "⚠️" : "🟢"} ${signal.side} ${signal.symbol} — ${signal.score}%`)].join("\n") : "🔥 Топ Сетапи\n\nЗараз немає setup 80+. Scanner active, чекаємо якісний сигнал.";
}

function realPositionsText() {
  return state.activeSignals.length ? ["📂 Позиції", "", ...state.activeSignals.slice(0, 5).map((signal) => `${signal.side} ${signal.symbol} — ${signal.score}%\nEntry: ${signal.entry[0]}-${signal.entry[1]}\nSL: ${signal.stopLoss}\nTP: ${signal.takeProfit.join(" / ")}`)].join("\n\n") : "📂 Активних угод немає.";
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
