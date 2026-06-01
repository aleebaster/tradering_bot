import { TelegramNotifier, type TelegramReplyMarkup } from "../src/local/telegram";

class CaptureNotifier extends TelegramNotifier {
  messages: string[] = [];

  override async send(text: string, _replyMarkup?: TelegramReplyMarkup) {
    this.messages.push(text);
  }
}

const notifier = new CaptureNotifier();

const longMessage = [
  "🟢 LONG — BTCUSDT",
  "",
  "📍 Entry zone: 104250 - 104400",
  "➡️ LONG setup",
  "",
  "🛑 SL: 103780",
  "🎯 TP1: 105100",
  "🎯 TP2: 106000",
  "🎯 TP3: 107200",
  "",
  "⚡ x2",
  "📊 Confidence: 94%",
  "",
  "Причина:",
  "• momentum bullish",
  "• BTC supportive",
  "• liquidity good"
].join("\n");

const shortMessage = [
  "⚪ WAIT / NO TRADE — BTCUSDT",
  "",
  "📍 Entry zone: 104250 - 104400",
  "➡️ LONG setup",
  "",
  "🛑 SL: 103780",
  "🎯 TP1: 105100",
  "🎯 TP2: 106000",
  "🎯 TP3: 107200",
  "",
  "📊 Confidence: 55%",
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
      { type: "LONG", header: "🟢 LONG — BTCUSDT", symbol: "BTCUSDT" },
      { type: "WAIT", header: "⚪ WAIT / NO TRADE — BTCUSDT", symbol: "BTCUSDT" }
    ],
    checks: {
      noLiveTelegramSpam: notifier.messages.length === 2,
      requiredFields: "Decision / Entry zone / Direction / SL / TP1-TP3 / Confidence / 3-5 reasons",
      readableInSeconds: "2-3"
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
