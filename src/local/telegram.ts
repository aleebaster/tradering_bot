import { config } from "./config";
import type { Signal } from "./types";

export class TelegramNotifier {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

  async started() {
    await this.send(["✅ AI Trading Signal Bot Started Successfully", "", "Diagnostics:", `• Mode: ${config.mode}`, `• OKX: ${config.partialMode ? "partial mode" : "authentication enabled"}`].join("\n"));
    if (config.warning) await this.diagnostics(config.warning);
  }

  async signal(signal: Signal) {
    if (signal.side === "NO_TRADE") return this.noTrade(signal);
    if (signal.side === "WATCHLIST") return this.diagnostics(formatWatchlist(signal));
    await this.send(formatSignal(signal));
  }

  async noTrade(signal: Signal) {
    await this.send([`❌ NO TRADE — ${signal.symbol}`, "", "Reason:", ...reasonBullets(signal)].join("\n"));
  }

  async exitAlert(signal: Signal, action: string, reasons: string[]) {
    await this.send([`🚪 EXIT ALERT — ${signal.symbol}`, "", `Action: ${action}`, "", "Reasons:", ...reasons.map((reason) => `✅ ${reason}`)].join("\n"));
  }

  async diagnostics(message: string) {
    await this.send(["🛠 DIAGNOSTICS", "", message].join("\n"));
  }

  async send(text: string) {
    if (!this.enabled) return;
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: branded(text) }) });
    if (!res.ok) throw new Error(`Telegram error ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
}

function branded(text: string) {
  return text.startsWith("🤖 OPENCODE BOT") ? text : `🤖 OPENCODE BOT\n\n${text}`;
}

function formatSignal(signal: Signal) {
  const market = signal.mode.toUpperCase();
  const side = signal.side === "BUY" ? "BUY" : signal.side;
  const icon = signal.mode === "futures" ? "🚀" : "📈";
  return [
    `${icon} ${market} ${side} — ${signal.symbol}`,
    "",
    "Status:",
    signal.entryStatus === "ENTER_NOW" ? "✅ ENTER NOW" : "⏳ WAIT FOR ENTRY",
    "",
    `Entry: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    `Current Price: ${fmt(signal.currentPrice)}`,
    signal.leverage ? `Leverage: ${signal.leverage}` : "",
    `SL: ${fmt(signal.stopLoss)}`,
    `TP1: ${fmt(signal.takeProfit[0])}`,
    `TP2: ${fmt(signal.takeProfit[1])}`,
    `TP3: ${fmt(signal.takeProfit[2])}`,
    `Risk/Reward: ${signal.riskReward}`,
    `Invalidation: ${fmt(signal.invalidationLevel)}`,
    "",
    `Confidence: ${signal.confidence}%`,
    `Win Probability: ${signal.winProbability}%`,
    "",
    "Reasons:",
    ...signal.reasons.map((reason) => `✅ ${reason}`)
  ].filter(Boolean).join("\n");
}

function formatWatchlist(signal: Signal) {
  return [`👀 WATCHLIST — ${signal.symbol}`, "", `Confidence: ${signal.confidence}%`, `Score: ${signal.score}/100`, "", "Reason:", ...reasonBullets(signal)].join("\n");
}

function reasonBullets(signal: Signal) {
  const reasons = signal.rejectionReason ? [signal.rejectionReason, ...signal.reasons] : signal.reasons;
  return reasons.map((reason) => `• ${reason}`);
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}
