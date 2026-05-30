import { config } from "./config";
import type { Signal } from "./types";

export class TelegramNotifier {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

  async started() {
    await this.send("✅ AI Trading Signal Bot Started Successfully");
    if (config.warning) await this.send(config.warning);
  }

  async signal(signal: Signal) {
    if (["NO_TRADE", "WATCHLIST"].includes(signal.side)) return;
    await this.send([
      `AI Crypto Signal: ${signal.symbol}`,
      `Action: ${signal.side}`,
      `Mode: ${signal.mode.toUpperCase()}`,
      `Score: ${signal.score}/100`,
      `Win Probability: ${signal.winProbability}%`,
      `Entry: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
      `SL: ${fmt(signal.stopLoss)}`,
      `TP1/TP2/TP3: ${signal.takeProfit.map(fmt).join(" / ")}`,
      signal.leverage ? `Leverage: ${signal.leverage}` : "",
      `Invalidation: ${fmt(signal.invalidationLevel)}`,
      `Management: ${signal.management}`,
      `Reasons: ${signal.reasons.join("; ")}`
    ].filter(Boolean).join("\n"));
  }

  async send(text: string) {
    if (!this.enabled) return;
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text }) });
    if (!res.ok) throw new Error(`Telegram error ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}
