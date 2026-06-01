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
  await click(center, checks, "DOGE", "DOGEUSDT");
  await click(center, checks, "🔍 Аналіз пари", "Введіть пару");
  await click(center, checks, "BTCUSDT", "Аналіз");
  await click(center, checks, "🔥 Топ Сетапи", "Топ Сетапи");
  await click(center, checks, "🔍 Пошук по парах", "Введіть пару");
  await click(center, checks, "📊 Статистика", "Торгова статистика");
  checks["pending_search_does_not_block_stats"] = center.status().pendingAction === null;
  await click(center, checks, "🪙 Нові монети", "НОВІ МОНЕТИ");
  await click(center, checks, "/newsignal AIGENSYNUSDT", "АНАЛІЗ НОВОЇ МОНЕТИ");
  await click(center, checks, "/learning", "Режим навчання");
  await click(center, checks, "/paperstats", "Памʼять paper-угод");
  await click(center, checks, "👀 Список моніторингу", "Список моніторингу");
  await click(center, checks, "➕ Додати пару", "Введіть пару");
  await click(center, checks, "AIGENSYNUSDT", "додано до списку моніторингу");
  await click(center, checks, "📄 Мій список", "Список моніторингу");
  await click(center, checks, "❌ Видалити пару", "Яку пару видалити");
  await click(center, checks, "AIGENSYNUSDT", "Видалено");
  await click(center, checks, "📈 Ринок", "Ринок");
  await click(center, checks, "🚨 Великі рухи", "Сканер сильних рухів");
  await click(center, checks, "/momentum", "Сканер сильних рухів");
  await click(center, checks, "📈 Лідери LONG", "Лідери LONG");
  await click(center, checks, "📉 Лідери SHORT", "Лідери SHORT");
  await click(center, checks, "🔥 Найсильніші рухи", "Найсильніші рухи");
  await click(center, checks, "🔍 Перевірити рух", "Перевірити великий рух");
  await click(center, checks, "ESPORTS", "ESPORTSUSDT");
  await click(center, checks, "🐋 Рух китів", "Сканер руху китів");
  await click(center, checks, "кити", "Сканер руху китів");
  await click(center, checks, "/whales", "Сканер руху китів");
  await click(center, checks, "🔍 Перевірити монету", "Перевірити великий рух");
  await click(center, checks, "btc", "ВЕЛИКИЙ РУХ");
  await click(center, checks, "🧠 Інтелект", "Інтелект");
  await center.handleCallbackForTest("ui:pump_detector");
  checks["inline_ui_pump_detector"] = last(notifier).includes("Детектор пампу") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:whale_bias");
  checks["inline_ui_whale_bias"] = last(notifier).includes("Перекіс китів") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:liquidation_status");
  checks["inline_ui_liquidation_status"] = last(notifier).includes("Ліквідації") || last(notifier).includes("Дані ще формуються");
  await center.handleCallbackForTest("ui:market_regime");
  checks["inline_ui_market_regime"] = last(notifier).includes("Режим ринку") || last(notifier).includes("Дані ще формуються");
  await click(center, checks, "₿ BTC Фільтр", "BTC Фільтр");
  await click(center, checks, "🧪 Діагностика", "Діагностика");
  await click(center, checks, "⚙️ Налаштування", "Налаштування");
  await click(center, checks, "💰 Баланс", "Поточний баланс");
  await click(center, checks, String(originalSettings.balanceUsdt), "Баланс оновлено");
  await click(center, checks, "⚡ Плече", "Плече");
  await click(center, checks, originalSettings.maxLeverage === "x5" ? "x2" : originalSettings.maxLeverage, "Поточний ліміт");
  await click(center, checks, "Обережний", "Режим ризику оновлено");
  await click(center, checks, "Збалансований", "Режим ризику оновлено");
  await click(center, checks, "Агресивний", "Режим ризику оновлено");
  await click(center, checks, "🎯 Режим ризику", "Режим ризику");
  await click(center, checks, riskModeButtonText(originalSettings.riskMode), "Режим ризику оновлено");
  await center.handleCallbackForTest("watch:BTCUSDT");
  checks["inline_watch"] = notifier.messages.slice(-2).some((message) => message.text.includes("додано до списку моніторингу") || message.text.includes("Моніторинг активний"));
  await center.handleCallbackForTest("refresh:BTCUSDT");
  checks["inline_refresh"] = notifier.messages.some((message) => message.text.includes("Аналізую BTCUSDT"));
  await center.handleCallbackForTest("full:BTCUSDT");
  checks["inline_full"] = last(notifier).includes("Повний аналіз");
  await center.handleCallbackForTest("remove:BTCUSDT");
  checks["inline_remove"] = last(notifier).includes("Видалено");
  await center.handleCallbackForTest("ui:settings");
  checks["inline_ui_settings"] = last(notifier).includes("Налаштування");
  await center.handleCallbackForTest("ui:risk_mode");
  checks["inline_ui_risk_mode"] = last(notifier).includes("Режим ризику");
  await center.handleCallbackForTest("ui:aggressive");
  checks["inline_ui_aggressive"] = last(notifier).includes("Режим ризику оновлено") && last(notifier).includes("Агресивний");
  await center.handleCallbackForTest("ui:balanced");
  checks["inline_ui_balanced"] = last(notifier).includes("Режим ризику оновлено") && last(notifier).includes("Збалансований");
  await center.handleCallbackForTest("ui:conservative");
  checks["inline_ui_conservative"] = last(notifier).includes("Режим ризику оновлено") && last(notifier).includes("Обережний");
  await center.handleCallbackForTest("ui:back");
  checks["inline_ui_back"] = last(notifier).includes("Головне меню");
  await center.handleCallbackForTest("ui:search_pair");
  checks["inline_ui_search_pair"] = last(notifier).includes("Введіть пару");
  await center.handleCallbackForTest("ui:top");
  checks["inline_ui_top"] = last(notifier).includes("Топ Сетапи");
  await center.handleCallbackForTest("ui:momentum");
  checks["inline_ui_momentum"] = last(notifier).includes("Сканер сильних рухів");
  await center.handleCallbackForTest("ui:momentum_check");
  checks["inline_ui_momentum_check"] = last(notifier).includes("Перевірити великий рух");
  await center.handleCallbackForTest("ui:whales");
  checks["inline_ui_whales"] = last(notifier).includes("Сканер руху китів");
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

function riskModeButtonText(value: string) {
  if (value === "Aggressive") return "Агресивний";
  if (value === "Balanced") return "Збалансований";
  return "Обережний";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
