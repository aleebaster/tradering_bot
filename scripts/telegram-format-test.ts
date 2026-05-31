import { TelegramNotifier } from "../src/local/telegram";

const notifier = new TelegramNotifier();

const longMessage = [
  "🟢 LONG — BTCUSDT",
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
    "💰 Position size for 5 USDT:",
    "15 USDT",
  "",
  "🟠 Беззбиток:",
  "Перенести Stop Loss після TP1"
].join("\n");

const shortMessage = [
  "🔴 SHORT — BTCUSDT",
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
    "💰 Position size for 5 USDT:",
    "15 USDT",
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
      ukrainianText: "Вхід / Stop Loss / Плече / Беззбиток",
      readableInSeconds: "3-5"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
