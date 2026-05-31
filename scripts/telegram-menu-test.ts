import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";

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

async function main() {
  await notifier.send(["📋 Головне меню", "", "Тест кнопкового Telegram UI.", "Натискай кнопки нижче без введення команд."].join("\n"), mainMenu);
  await notifier.send(["🟢 LONG — BTCUSDT", "", "✅ ЗАХОДИТИ ЗАРАЗ", "", "📍 Вхід:", "104250-104400", "", "🛑 SL:", "103780", "", "🎯 TP1:", "105100", "", "⚡ Плече:", "x3", "", "💰 Баланс:", "5 USDT", "", "📦 Вхід:", "15 USDT"].join("\n"), signalActions);
  console.log(JSON.stringify({
    ok: true,
    sent: ["reply_keyboard_main_menu", "inline_signal_quick_actions"],
    proof: {
      replyKeyboardRows: mainMenu.keyboard?.length,
      inlineKeyboardRows: signalActions.inline_keyboard?.length,
      buttons: ["📊 Сигнали", "👀 Watchlist", "📈 Ринок", "₿ BTC Фільтр", "🔥 Топ Сетапи", "📂 Позиції", "🧪 Діагностика", "⚙️ Налаштування", "🟢 Моніторити", "🔄 Оновити", "❌ Видалити", "📊 Повний аналіз"]
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
