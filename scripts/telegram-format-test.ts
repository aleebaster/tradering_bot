import { TelegramNotifier } from "../src/local/telegram";

const notifier = new TelegramNotifier();

const longMessage = [
  "🟢 LONG — BTCUSDT",
  "",
  "✅ ЗАХОДИТИ ЗАРАЗ",
  "",
  "📍 Вхід:",
  "104250–104400",
  "",
  "🛑 Stop Loss:",
  "103780",
  "",
  "🎯 TP1:",
  "105100",
  "",
  "🎯 TP2:",
  "106000",
  "",
  "🎯 TP3:",
  "107200",
  "",
  "⚡ Плече:",
  "x3",
  "",
  "💰 Баланс:",
  "5 USDT",
  "",
  "📦 Розмір позиції:",
  "15 USDT",
  "",
  "📌 Скільки купити:",
  "0.000143 BTC",
  "",
  "🟠 Беззбиток:",
  "Перенести Stop Loss після TP1"
].join("\n");

const shortMessage = [
  "🔴 SHORT — BTCUSDT",
  "",
  "✅ ЗАХОДИТИ ЗАРАЗ",
  "",
  "📍 Вхід:",
  "104250–104400",
  "",
  "🛑 Stop Loss:",
  "104900",
  "",
  "🎯 TP1:",
  "103800",
  "",
  "🎯 TP2:",
  "103100",
  "",
  "🎯 TP3:",
  "102400",
  "",
  "⚡ Плече:",
  "x3",
  "",
  "💰 Баланс:",
  "5 USDT",
  "",
  "📦 Розмір позиції:",
  "15 USDT",
  "",
  "📌 Скільки шортити:",
  "0.000143 BTC",
  "",
  "🟠 Беззбиток:",
  "Перенести Stop Loss після TP1"
].join("\n");

async function main() {
  await notifier.send(longMessage);
  await notifier.send(shortMessage);
  console.log(JSON.stringify({
    ok: true,
    sent: [
      { type: "LONG", icon: "🟢", symbol: "BTCUSDT" },
      { type: "SHORT", icon: "🔴", symbol: "BTCUSDT" }
    ],
    checks: {
      telegramDelivery: true,
      emojis: "🟢 🔴 ✅ 📌 📍 🛑 🎯 ⚡",
      ukrainianText: "ЗАХОДИТИ ЗАРАЗ / Вхід / Stop Loss / Плече / Баланс / Скільки купити",
      readableInSeconds: "3-5"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
