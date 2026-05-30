import { config } from "./config";
import type { Signal } from "./types";

export class TelegramNotifier {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);

  async started() {
    await this.send(["✅ ШІ-бот торгових сигналів успішно запущено", "", "Діагностика:", `• Режим: ${modeUa(config.mode)}`, `• OKX: ${config.partialMode ? "частковий режим" : "автентифікацію увімкнено"}`].join("\n"));
    if (config.warning) await this.diagnostics(config.warning);
  }

  async signal(signal: Signal) {
    if (signal.side === "NO_TRADE") return this.noTrade(signal);
    if (signal.side === "WATCHLIST") return this.diagnostics(formatWatchlist(signal));
    await this.send(formatSignal(signal));
  }

  async noTrade(signal: Signal) {
    await this.send([`❌ НЕ ВХОДИТИ — ${signal.symbol}`, "", "Причина:", ...reasonBullets(signal)].join("\n"));
  }

  async exitAlert(signal: Signal, action: string, reasons: string[]) {
    await this.tradeManagementAlert(signal, action, signal.currentPrice, reasons);
  }

  async tradeManagementAlert(signal: Signal, action: string, currentPrice: number, reasons: string[]) {
    await this.send([
      `${action} — ${signal.symbol}`,
      "",
      `Поточна ціна: ${fmt(currentPrice)}`,
      `Зона входу: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
      `Стоп-лосс: ${fmt(signal.stopLoss)}`,
      `TP1: ${fmt(signal.takeProfit[0])}`,
      `TP2: ${fmt(signal.takeProfit[1])}`,
      `TP3: ${fmt(signal.takeProfit[2])}`,
      `Співвідношення ризик/прибуток: ${signal.riskReward}`,
      signal.leverage ? `Рекомендоване плече: ${signal.leverage}` : "",
      "",
      "Причини:",
      ...reasons.map((reason) => `✅ ${reason}`)
    ].filter(Boolean).join("\n"));
  }

  async diagnostics(message: string) {
    await this.send(["🛠 ДІАГНОСТИКА", "", message].join("\n"));
  }

  async send(text: string) {
    if (!this.enabled) return;
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: branded(text) }) });
    if (!res.ok) throw new Error(`Помилка Telegram ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
}

function modeUa(mode: string) {
  return mode === "LOCAL_ONLY" ? "локальний" : mode === "HYBRID" ? "гібридний" : mode === "OFFLINE_TEST" ? "тест без підключень" : mode;
}

function branded(text: string) {
  return text.startsWith("🤖 OPENCODE BOT") ? text : `🤖 OPENCODE BOT\n\n${text}`;
}

function formatSignal(signal: Signal) {
  const market = signal.mode === "futures" ? "Ф'ЮЧЕРС" : "SPOT";
  const side = signal.side === "BUY" ? "BUY" : signal.side;
  const icon = signal.mode === "futures" ? "🚀" : "📈";
  return [
    `${icon} ${market} ${side} — ${signal.symbol}`,
    "",
    "Статус:",
    signal.entryStatus === "ENTER_NOW" ? "✅ ЗАХОДИТИ ЗАРАЗ" : "⏳ ЧЕКАТИ ЗОНУ ВХОДУ",
    "",
    `Зона входу: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    `Поточна ціна: ${fmt(signal.currentPrice)}`,
    signal.leverage ? `Рекомендоване плече: ${signal.leverage}` : "",
    `Стоп-лосс: ${fmt(signal.stopLoss)}`,
    `TP1: ${fmt(signal.takeProfit[0])}`,
    `TP2: ${fmt(signal.takeProfit[1])}`,
    `TP3: ${fmt(signal.takeProfit[2])}`,
    `Співвідношення ризик/прибуток: ${signal.riskReward}`,
    `Рівень інвалідації: ${fmt(signal.invalidationLevel)}`,
    "",
    `Впевненість: ${signal.confidence}%`,
    `Ймовірність успіху: ${signal.winProbability}%`,
    "",
    "📡 Підтверджено:",
    ...confirmationLines(signal),
    "",
    "Причини:",
    ...signal.reasons.map((reason) => `✅ ${reason}`)
  ].filter(Boolean).join("\n");
}

function confirmationLines(signal: Signal) {
  return [
    signal.confirmations.bybit ? "✅ Bybit" : "❌ Bybit",
    signal.confirmations.okx ? "✅ OKX" : "❌ OKX",
    signal.confirmations.kucoin ? "✅ KuCoin" : "❌ KuCoin",
    signal.confirmations.kraken ? "✅ Kraken" : "❌ Kraken",
    signal.confirmations.binance ? "✅ Binance market confirmation" : "❌ Binance market confirmation"
  ];
}

function formatWatchlist(signal: Signal) {
  return [`👀 СПОСТЕРЕЖЕННЯ — ${signal.symbol}`, "", `Впевненість: ${signal.confidence}%`, `Оцінка: ${signal.score}/100`, "", "Причина:", ...reasonBullets(signal)].join("\n");
}

function reasonBullets(signal: Signal) {
  const reasons = signal.rejectionReason ? [signal.rejectionReason, ...signal.reasons] : signal.reasons;
  return reasons.map((reason) => `• ${reason}`);
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}
