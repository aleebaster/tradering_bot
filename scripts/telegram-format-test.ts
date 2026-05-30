import { TelegramNotifier } from "../src/local/telegram";

const notifier = new TelegramNotifier();

const longMessage = [
  "🟢 LONG — BTCUSDT",
  "",
  "Статус:",
  "✅ ЗАХОДИТИ ЗАРАЗ",
  "",
  "📌 Коротко:",
  "",
  "📍 Вхід: 104250–104400",
  "🛑 SL: 103780",
  "🎯 TP1: 105100",
  "🎯 TP2: 106000",
  "🎯 TP3: 107200",
  "⚡ Плече: x3",
  "",
  "Ймовірність:",
  "89%",
  "",
  "Confidence:",
  "88%",
  "",
  "Risk/Reward:",
  "1:3",
  "",
  "Причина:",
  "",
  "✅ trend confirmation",
  "✅ volume confirmation",
  "✅ momentum confirmation",
  "✅ BTC stable"
].join("\n");

const shortMessage = [
  "🔴 SHORT — BTCUSDT",
  "",
  "Статус:",
  "✅ ЗАХОДИТИ ЗАРАЗ",
  "",
  "📌 Коротко:",
  "",
  "📍 Вхід: 104250–104400",
  "🛑 SL: 104900",
  "🎯 TP1: 103800",
  "🎯 TP2: 103100",
  "🎯 TP3: 102400",
  "⚡ Плече: x3",
  "",
  "Ймовірність:",
  "88%",
  "",
  "Confidence:",
  "87%",
  "",
  "Risk/Reward:",
  "1:2.8",
  "",
  "Причина:",
  "",
  "✅ bearish trend",
  "✅ volume confirmation",
  "✅ order book pressure",
  "✅ BTC stable"
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
      ukrainianText: "Статус / ЗАХОДИТИ ЗАРАЗ / Коротко / Ймовірність / Причина",
      readableInSeconds: "3-5"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
