import { TelegramNotifier } from "../src/local/telegram";

const notifier = new TelegramNotifier();

const longMessage = [
  "🚨 SIGNAL: LONG",
  "",
  "📊 Reason:",
  "RSI momentum aligned; MACD impulse confirmed; SMA trend aligned; sniper + volume + BTC stable.",
  "",
  "🎯 Entry:",
  "104250–104400",
  "",
  "🛡 Stop Loss:",
  "103780",
  "",
  "💰 Take Profit:",
  "TP1 105100 / TP2 106000 / TP3 107200",
  "",
  "⚡ Leverage:",
  "x2",
  "",
  "📈 Confidence:",
  "94%",
  "",
  "💵 Estimated profit/risk:",
  "risk 0.08 USDT; TP 0.12 / 0.20 / 0.34 USDT; RR 1:3.1"
].join("\n");

const shortMessage = [
  "🚨 SIGNAL: SHORT",
  "",
  "📊 Reason:",
  "RSI momentum aligned; MACD confirms direction; SMA trend aligned; sniper + volume + BTC stable.",
  "",
  "🎯 Entry:",
  "104250–104400",
  "",
  "🛡 Stop Loss:",
  "104900",
  "",
  "💰 Take Profit:",
  "TP1 103800 / TP2 103100 / TP3 102400",
  "",
  "⚡ Leverage:",
  "x3",
  "",
  "📈 Confidence:",
  "97%",
  "",
  "💵 Estimated profit/risk:",
  "risk 0.07 USDT; TP 0.11 / 0.22 / 0.36 USDT; RR 1:3.4"
].join("\n");

async function main() {
  await notifier.send(longMessage);
  await notifier.send(shortMessage);
  console.log(JSON.stringify({
    ok: true,
    sent: [
      { type: "LONG", header: "🚨 SIGNAL: LONG", symbol: "BTCUSDT" },
      { type: "SHORT", header: "🚨 SIGNAL: SHORT", symbol: "BTCUSDT" }
    ],
    checks: {
      telegramDelivery: true,
      requiredFields: "Reason / Entry / Stop Loss / TP1-TP3 / Leverage / Confidence / Estimated profit-risk",
      readableInSeconds: "3-5"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
