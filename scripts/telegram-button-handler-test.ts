import { TelegramCommandCenter, type TelegramCommandHandler } from "../src/local/telegramCommands";
import { loadTelegramSettings, updateTelegramSettings } from "../src/local/telegramSettings";
import type { TelegramReplyMarkup } from "../src/local/telegram";

class CaptureNotifier implements TelegramCommandHandler {
  messages: { text: string; replyMarkup?: TelegramReplyMarkup }[] = [];

  async send(text: string, replyMarkup?: TelegramReplyMarkup) {
    this.messages.push({ text, replyMarkup });
  }
}

async function main() {
  process.env.TELEGRAM_HANDLER_TEST = "1";
  const originalSettings = loadTelegramSettings();
  const notifier = new CaptureNotifier();
  const center = new TelegramCommandCenter(notifier);

  const checks: Record<string, boolean> = {};
  await click(center, checks, "📊 Сигнали", "📊 Сигнали");
  await click(center, checks, "🔍 Пошук по парах", "Введіть пару");
  await click(center, checks, "DOGE", "📍 Entry");
  await click(center, checks, "🔍 Аналіз пари", "Введіть пару");
  await click(center, checks, "BTCUSDT", "Аналіз");
  await click(center, checks, "🔥 Топ Сетапи", "Топ Сетапи");
  await click(center, checks, "🔍 Пошук по парах", "Введіть пару");
  await click(center, checks, "📊 Статистика", "Trading Stats");
  checks["pending_search_does_not_block_stats"] = center.status().pendingAction === null;
  await click(center, checks, "🚀 New Tokens", "NEW TOKENS WATCH");
  await click(center, checks, "/newsignal AIGENSYNUSDT", "NEW TOKEN ANALYSIS");
  await click(center, checks, "/learning", "Learning Mode");
  await click(center, checks, "/paperstats", "Paper Trade Memory");
  await click(center, checks, "👀 Watchlist", "Watchlist");
  await click(center, checks, "➕ Додати пару", "Введіть пару");
  await click(center, checks, "AIGENSYNUSDT", "додано до Watchlist");
  await click(center, checks, "📄 Мій список", "Watchlist");
  await click(center, checks, "❌ Видалити пару", "Яку пару видалити");
  await click(center, checks, "AIGENSYNUSDT", "Видалено");
  await click(center, checks, "📈 Ринок", "Ринок");
  await click(center, checks, "🚨 Великі рухи", "Momentum Scanner");
  await click(center, checks, "/momentum", "Momentum Scanner");
  await click(center, checks, "📈 LONG movers", "LONG movers");
  await click(center, checks, "📉 SHORT movers", "SHORT movers");
  await click(center, checks, "🔥 Найсильніші рухи", "Найсильніші рухи");
  await click(center, checks, "🔍 Перевірити рух", "Перевірити великий рух");
  await click(center, checks, "ESPORTS", "ESPORTSUSDT");
  await click(center, checks, "🐋 Рух китів", "Whale Flow Scanner");
  await click(center, checks, "кити", "Whale Flow Scanner");
  await click(center, checks, "/whales", "Whale Flow Scanner");
  await click(center, checks, "🔍 Перевірити монету", "Перевірити великий рух");
  await click(center, checks, "btc", "ВЕЛИКИЙ РУХ");
  await click(center, checks, "📡 Intelligence", "Intelligence");
  await center.handleCallbackForTest("ui:pump_detector");
  checks["inline_ui_pump_detector"] = last(notifier).includes("Pump Detector") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:whale_bias");
  checks["inline_ui_whale_bias"] = last(notifier).includes("Whale Bias") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:liquidation_status");
  checks["inline_ui_liquidation_status"] = last(notifier).includes("Liquidation Status") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:market_regime");
  checks["inline_ui_market_regime"] = last(notifier).includes("Market Regime") || last(notifier).includes("Дані ще формуються");
  await click(center, checks, "₿ BTC Фільтр", "BTC Фільтр");
  await click(center, checks, "🧪 Діагностика", "Діагностика");
  await click(center, checks, "⚙️ Налаштування", "Налаштування");
  await click(center, checks, "💰 Баланс", "Поточний баланс");
  await click(center, checks, String(originalSettings.balanceUsdt), "Баланс оновлено");
  await click(center, checks, "⚡ Плече", "Плече");
  await click(center, checks, originalSettings.maxLeverage === "x5" ? "x2" : originalSettings.maxLeverage, "Поточний ліміт");
  await click(center, checks, "Conservative", "Risk mode оновлено");
  await click(center, checks, "Balanced", "Risk mode оновлено");
  await click(center, checks, "Aggressive", "Risk mode оновлено");
  await click(center, checks, "🎯 Risk mode", "Risk mode");
  await click(center, checks, originalSettings.riskMode, "Risk mode оновлено");
  await center.handleCallbackForTest("watch:BTCUSDT");
  checks["inline_watch"] = notifier.messages.slice(-2).some((message) => message.text.includes("додано до Watchlist"));
  await center.handleCallbackForTest("refresh:BTCUSDT");
  checks["inline_refresh"] = notifier.messages.some((message) => message.text.includes("Аналізую BTCUSDT"));
  await center.handleCallbackForTest("full:BTCUSDT");
  checks["inline_full"] = last(notifier).includes("Повний аналіз");
  await center.handleCallbackForTest("remove:BTCUSDT");
  checks["inline_remove"] = last(notifier).includes("Видалено");
  await center.handleCallbackForTest("ui:settings");
  checks["inline_ui_settings"] = last(notifier).includes("Налаштування");
  await center.handleCallbackForTest("ui:risk_mode");
  checks["inline_ui_risk_mode"] = last(notifier).includes("Risk mode");
  await center.handleCallbackForTest("ui:aggressive");
  checks["inline_ui_aggressive"] = last(notifier).includes("Risk mode оновлено") && last(notifier).includes("Aggressive");
  await center.handleCallbackForTest("ui:balanced");
  checks["inline_ui_balanced"] = last(notifier).includes("Risk mode оновлено") && last(notifier).includes("Balanced");
  await center.handleCallbackForTest("ui:conservative");
  checks["inline_ui_conservative"] = last(notifier).includes("Risk mode оновлено") && last(notifier).includes("Conservative");
  await center.handleCallbackForTest("ui:back");
  checks["inline_ui_back"] = last(notifier).includes("Головне меню");
  await center.handleCallbackForTest("ui:search_pair");
  checks["inline_ui_search_pair"] = last(notifier).includes("Введіть пару");
  await center.handleCallbackForTest("ui:top");
  checks["inline_ui_top"] = last(notifier).includes("Топ Сетапи");
  await center.handleCallbackForTest("ui:momentum");
  checks["inline_ui_momentum"] = last(notifier).includes("Momentum Scanner");
  await center.handleCallbackForTest("ui:momentum_check");
  checks["inline_ui_momentum_check"] = last(notifier).includes("Перевірити великий рух");
  await center.handleCallbackForTest("ui:whales");
  checks["inline_ui_whales"] = last(notifier).includes("Whale Flow Scanner");
  await center.handleCallbackForTest("ui:whales_check");
  checks["inline_ui_whales_check"] = last(notifier).includes("Перевірити монету");

  updateTelegramSettings(originalSettings);

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, sentMessages: notifier.messages.length, failed }, null, 2));
  if (failed.length) process.exit(1);
}

async function click(center: TelegramCommandCenter, checks: Record<string, boolean>, text: string, expected: string) {
  const key = text.replace(/\s+/g, "_");
  const before = (center as unknown as { notifier: CaptureNotifier }).notifier.messages.length;
  await center.handleForTest(text);
  const after = (center as unknown as { notifier: CaptureNotifier }).notifier.messages.slice(before).map((message) => message.text).join("\n---\n");
  checks[key] = after.includes(expected);
}

function last(notifier: CaptureNotifier) {
  return notifier.messages.at(-1)?.text ?? "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
