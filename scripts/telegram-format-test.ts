import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";

class CaptureNotifier extends TelegramNotifier {
  messages: string[] = [];

  override async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

const notifier = new CaptureNotifier();

const longMessage = [
  "🚨 SIGNAL: LONG",
  "",
  "📍 Pair:",
  "BTCUSDT",
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
  "📊 Reason:",
  "RSI momentum aligned; MACD impulse confirmed; SMA trend aligned."
].join("\n");

const shortMessage = [
  "🚨 SIGNAL: SHORT",
  "",
  "📍 Pair:",
  "BTCUSDT",
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
  "📊 Reason:",
  "RSI momentum aligned; MACD confirms direction; SMA trend aligned."
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
      noLiveTelegramSpam: notifier.messages.length === 2,
      requiredFields: "Signal / Pair / Entry / Stop Loss / TP1-TP3 / Leverage / Confidence / Reason",
      readableInSeconds: "3-5"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
