import { config } from "./config";
import type { Signal } from "./types";

export type TelegramReplyMarkup = {
  keyboard?: { text: string }[][];
  inline_keyboard?: { text: string; callback_data: string }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
};

export class TelegramNotifier {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

  async started() {
    return;
  }

  async signal(signal: Signal) {
    if (!isRealEntrySignal(signal)) return;
    await this.send(formatExecutionSignal(signal), signalQuickActions(signal.symbol));
  }

  async setupActivated(signal: Signal, reasons: string[]) {
    return this.signal(signal);
  }

  async setupUpgraded(signal: Signal, reasons: string[]) {
    return this.signal(signal);
  }

  async pumpDetected(signal: Signal, reasons: string[]) {
    return;
  }

  async setupInvalidated(signal: Signal, reasons: string[]) {
    return;
  }

  async noTrade(signal: Signal) {
    return;
  }

  async exitAlert(signal: Signal, action: string, reasons: string[]) {
    return;
  }

  async tradeManagementAlert(signal: Signal, action: string, currentPrice: number, reasons: string[]) {
    return;
  }

  async diagnostics(message: string) {
    return;
  }

  async send(text: string, replyMarkup?: TelegramReplyMarkup) {
    if (!this.enabled) return;
    const chunks = chunkTelegramText(text);
    for (let index = 0; index < chunks.length; index++) await this.sendChunk(chunks[index], index === chunks.length - 1 ? replyMarkup : undefined);
  }

  private async sendChunk(text: string, replyMarkup?: TelegramReplyMarkup) {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: config.TELEGRAM_CHAT_ID, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Помилка Telegram ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }

  isEnabled() {
    return this.enabled;
  }
}

export function signalQuickActions(symbol: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🟢 Моніторити", callback_data: `watch:${symbol}` }, { text: "🔄 Оновити Аналіз", callback_data: `refresh:${symbol}` }],
      [{ text: "📈 Детальний аналіз", callback_data: `analyze_futures:${symbol}` }, { text: "❌ Видалити", callback_data: `remove:${symbol}` }]
    ]
  };
}

function modeUa(mode: string) {
  return mode === "LOCAL_ONLY" ? "локальний" : mode === "HYBRID" ? "гібридний" : mode === "OFFLINE_TEST" ? "тест без підключень" : mode;
}

export function formatExecutionSignal(signal: Signal) {
  const leverage = strongestSetup(signal) ? "x3" : "x2";
  const status = executionStatus(signal);
  const label = status.replace(/^[^\s]+\s/, "");
  return [
    `${status.split(" ")[0]} ${signal.symbol} — ${label}`,
    "",
    `📍 Entry: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    "",
    `🎯 TP1: ${fmt(signal.takeProfit[0])}`,
    `🎯 TP2: ${fmt(signal.takeProfit[1])}`,
    `🎯 TP3: ${fmt(signal.takeProfit[2])}`,
    "",
    `⚡ ${leverage}`,
    `🔥 Confidence: ${signal.confidence}%`,
    `📊 RR: ${signal.riskReward}`,
    "",
    "Причина:",
    ...executionReasons(signal).map((reason) => `${label === "NO TRADE" ? "•" : "✅"} ${reason}`),
    label === "NO TRADE" ? "" : null,
    label === "NO TRADE" ? "⏱ Recheck: 2 min" : null
  ].filter(Boolean).join("\n");
}

export function isRealEntrySignal(signal: Signal) {
  const sideOk = signal.side === "LONG" || signal.side === "SHORT" || signal.side === "BUY";
  const entryLow = Math.min(...signal.entry);
  const entryHigh = Math.max(...signal.entry);
  const inEntryZone = signal.currentPrice >= entryLow && signal.currentPrice <= entryHigh;
  const breakdown = signal.scoreBreakdown ?? {};
  const threshold = breakdown.adaptiveConfirmationRequired ?? 92;
  const enoughConfirmations = [
    (breakdown.entrySniper ?? 0) >= 70,
    (breakdown.volumeConfirmation ?? 0) >= 65,
    (breakdown.momentumQuality ?? 0) >= 70,
    (breakdown.orderBookImbalance ?? 0) >= 60,
    (breakdown.liquiditySweep ?? 0) >= 65,
    (breakdown.multiTimeframeAlignment ?? 0) >= 55,
    signal.confirmations.alignedCount >= 1 || signal.symbol === "BTCUSDT"
  ].filter(Boolean).length >= 6;
  return sideOk
    && signal.entryStatus === "ENTER_NOW"
    && signal.score >= threshold
    && inEntryZone
    && (signal.btcStable || signal.symbol === "BTCUSDT")
    && enoughConfirmations
    && !signal.fakeBreakout.risk
    && !signal.newsRisk.blocked
    && rrNumber(signal.riskReward) >= 2;
}

function executionStatus(signal: Signal) {
  if (signal.entryStatus === "ENTER_NOW" && signal.side !== "NO_TRADE" && signal.side !== "WATCHLIST") return "🚀 ENTER NOW";
  if (signal.entryStatus === "WAIT_FOR_ENTRY" && signal.score >= 88) return "✅ READY";
  if (signal.side === "WATCHLIST" || signal.score >= 72) return "👀 WATCHLIST";
  return "❌ NO TRADE";
}

function executionReasons(signal: Signal) {
  const breakdown = signal.scoreBreakdown;
  const noTrade = executionStatus(signal).includes("NO TRADE");
  const positive = [
    (breakdown.momentumQuality ?? 0) >= 70 ? "momentum confirm" : null,
    (breakdown.openInterestConfirmation ?? 0) >= 65 ? "OI confirm" : null,
    (breakdown.volumeConfirmation ?? 0) >= 65 ? "volume confirm" : null,
    (breakdown.entrySniper ?? 0) >= 70 ? "sniper trigger" : null,
    signal.btcStable || signal.symbol === "BTCUSDT" ? "BTC stable" : null,
    (breakdown.liquiditySweep ?? 0) >= 65 ? "retest confirm" : null
  ].filter(Boolean) as string[];
  const blockers = [
    (breakdown.volumeConfirmation ?? 0) < 65 ? "weak volume" : null,
    (breakdown.entrySniper ?? 0) < 70 ? "no sniper trigger" : null,
    (breakdown.liquiditySweep ?? 0) < 65 ? "no retest" : null,
    !signal.btcStable && signal.symbol !== "BTCUSDT" ? "BTC not stable" : null,
    signal.fakeBreakout.risk ? "fake breakout risk" : null
  ].filter(Boolean) as string[];
  if (noTrade) return blockers.slice(0, 5);
  return [...positive, ...blockers.filter((reason) => !positive.includes(reason))].slice(0, 5);
}

function strongestSetup(signal: Signal) {
  return signal.score >= 96 && signal.confidence >= 94 && (signal.scoreBreakdown.entrySniper ?? 0) >= 90 && (signal.scoreBreakdown.volumeConfirmation ?? 0) >= 75;
}

function rrNumber(value: string) {
  const colon = value.match(/:\s*([0-9]+(?:\.[0-9]+)?)/);
  if (colon) return Number(colon[1]);
  const match = value.match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : 0;
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}

function chunkTelegramText(text: string) {
  const limit = 3900;
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = Math.max(rest.lastIndexOf("\n", limit), Math.floor(limit * 0.8));
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
