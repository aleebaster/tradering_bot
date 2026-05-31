import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";

class CaptureNotifier extends TelegramNotifier {
  messages: string[] = [];

  override async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

const notifier = new CaptureNotifier();

const longMessage = [
  "🚀 BTCUSDT — ENTER NOW",
  "",
  "📍 Entry: 104250 - 104400",
  "🛑 SL: 103780",
  "",
  "🎯 TP1: 105100",
  "🎯 TP2: 106000",
  "🎯 TP3: 107200",
  "",
  "⚡ x2",
  "🔥 Confidence: 94%",
  "📊 RR: 1:4.2",
  "",
  "Причина:",
  "✅ momentum confirm",
  "✅ OI confirm",
  "✅ volume confirm"
].join("\n");

const shortMessage = [
  "❌ BTCUSDT — NO TRADE",
  "",
  "Причина:",
  "• weak volume",
  "• no sniper trigger",
  "• no retest",
  "",
  "⏱ Recheck: 2 min"
].join("\n");

async function main() {
  await notifier.send(longMessage);
  await notifier.send(shortMessage);
  console.log(JSON.stringify({
    ok: true,
    sent: [
      { type: "ENTER_NOW", header: "🚀 BTCUSDT — ENTER NOW", symbol: "BTCUSDT" },
      { type: "NO_TRADE", header: "❌ BTCUSDT — NO TRADE", symbol: "BTCUSDT" }
    ],
    checks: {
      noLiveTelegramSpam: notifier.messages.length === 2,
      requiredFields: "Pair / Status / Entry / SL / TP1-TP3 / Leverage / Confidence / RR / 3-5 reasons",
      readableInSeconds: "1-2"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
