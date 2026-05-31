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
    await this.send(["✅ ШІ-бот торгових сигналів успішно запущено", "", "Діагностика:", `• Режим: ${modeUa(config.mode)}`, `• OKX: ${config.partialMode ? "частковий режим" : "автентифікацію увімкнено"}`].join("\n"));
    if (config.warning) await this.diagnostics(config.warning);
  }

  async signal(signal: Signal) {
    if (signal.side === "NO_TRADE") return this.noTrade(signal);
    if (signal.side === "WATCHLIST") return this.diagnostics(formatWatchlist(signal));
    await this.send(formatSignal(signal), signalQuickActions(signal.symbol));
  }

  async setupActivated(signal: Signal, reasons: string[]) {
    const side = signal.side === "SHORT" ? "🔴 SETUP ACTIVATED" : "🟢 SETUP ACTIVATED";
    await this.send([`${side} — ${signal.symbol}`, "", formatSignal({ ...signal, entryStatus: "ENTER_NOW" })].join("\n"), signalQuickActions(signal.symbol));
  }

  async setupInvalidated(signal: Signal, reasons: string[]) {
    await this.noTrade(signal);
  }

  async noTrade(signal: Signal) {
    await this.send(formatNoTrade(signal));
  }

  async exitAlert(signal: Signal, action: string, reasons: string[]) {
    await this.tradeManagementAlert(signal, action, signal.currentPrice, reasons);
  }

  async tradeManagementAlert(signal: Signal, action: string, currentPrice: number, reasons: string[]) {
    await this.send([
      action,
      reasons.length ? "" : null,
      ...reasons,
      "",
      `Ціна: ${fmt(currentPrice)}`
    ].filter(Boolean).join("\n"));
  }

  async diagnostics(message: string) {
    await this.send(["🛠 ДІАГНОСТИКА", "", message].join("\n"));
  }

  async send(text: string, replyMarkup?: TelegramReplyMarkup) {
    if (!this.enabled) return;
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: config.TELEGRAM_CHAT_ID, text: branded(text) };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      [{ text: "📊 Повний Аналіз", callback_data: `full:${symbol}` }, { text: "❌ Видалити", callback_data: `remove:${symbol}` }]
    ]
  };
}

function modeUa(mode: string) {
  return mode === "LOCAL_ONLY" ? "локальний" : mode === "HYBRID" ? "гібридний" : mode === "OFFLINE_TEST" ? "тест без підключень" : mode;
}

function branded(text: string) {
  return text.startsWith("🤖 OPENCODE BOT") ? text : `🤖 OPENCODE BOT\n\n${text}`;
}

function formatSignal(signal: Signal) {
  const direction = signal.side === "SHORT" ? "SHORT" : signal.side === "BUY" ? "LONG" : "LONG";
  const icon = direction === "SHORT" ? "🔴" : "🟢";
  const sizing = signal.positionSizing;
  return [
    `${icon} ${direction} — ${signal.symbol}`,
    "",
    signal.entryStatus === "ENTER_NOW" ? "✅ ЗАХОДИТИ ЗАРАЗ" : "⏳ ЧЕКАТИ ЗОНУ ВХОДУ",
    "",
    "📍 Вхід:",
    `${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    "",
    "🛑 SL:",
    fmt(signal.stopLoss),
    "",
    "🎯 TP1:",
    fmt(signal.takeProfit[0]),
    "",
    "🎯 TP2:",
    fmt(signal.takeProfit[1]),
    "",
    "🎯 TP3:",
    fmt(signal.takeProfit[2]),
    "",
    `⚡ ${leverageText(signal)}`,
    "",
    `💰 ${sizing?.balanceUsdt ?? config.USER_BALANCE_USDT} USDT → ${sizing ? `${sizing.positionSizeUsdt} USDT` : "після підтвердження"}`,
    "",
    "🟠 Беззбиток:",
    smartBreakevenText(signal)
  ].filter(Boolean).join("\n");
}

function formatWatchlist(signal: Signal) {
  return formatWaitingSignal(signal, "⚠️ WATCHLIST ONLY");
}

function formatNoTrade(signal: Signal) {
  return formatWaitingSignal(signal, "ОЧІКУВАННЯ");
}

function formatWaitingSignal(signal: Signal, label: string) {
  const direction = potentialDirection(signal);
  const trigger = waitingTriggers(signal, direction);
  return [
    `🚨 СИГНАЛ: ${label}`,
    "",
    "📊 Обґрунтування:",
    waitingReason(signal, direction),
    "",
    "⏳ Що чекаємо:",
    ...trigger,
    "",
    "📍 Потенційна зона входу:",
    `${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    "",
    "🛡 Потенційний Stop-Loss:",
    fmt(signal.stopLoss),
    "",
    "💰 Потенційні TP:",
    `TP1: ${fmt(signal.takeProfit[0])}`,
    `TP2: ${fmt(signal.takeProfit[1])}`,
    `TP3: ${fmt(signal.takeProfit[2])}`,
    "",
    "⚡ Потенційне плече:",
    potentialLeverage(signal),
    "",
    "🟠 Беззбиток:",
    smartBreakevenText(signal),
    "",
    "📈 Confidence:",
    `${signal.confidence}%`,
    "",
    "💰 Risk/Reward:",
    signal.riskReward
  ].join("\n");
}

function potentialDirection(signal: Signal) {
  if (signal.side === "SHORT") return "SHORT";
  if (signal.side === "LONG" || signal.side === "BUY") return "LONG";
  const averageEntry = (signal.entry[0] + signal.entry[1]) / 2;
  return signal.stopLoss > averageEntry ? "SHORT" : "LONG";
}

function waitingReason(signal: Signal, direction: "LONG" | "SHORT") {
  const momentum = signal.scoreBreakdown.momentumQuality ?? 0;
  const volume = signal.scoreBreakdown.volumeConfirmation ?? 0;
  const smas = signal.scoreBreakdown.multiTimeframeAlignment ?? 0;
  const orderbook = signal.scoreBreakdown.orderBookImbalance ?? 0;
  const bias = direction === "SHORT" ? "bearish" : "bullish";
  const momentumText = momentum >= 70 ? "momentum підтверджує напрям" : momentum >= 45 ? "momentum нейтральний" : "momentum слабкий";
  const volumeText = volume >= 65 ? "volume підтверджує рух" : "volume ще слабкий";
  const smaText = smas >= 67 ? "SMA/EMA alignment достатній" : "SMA/EMA alignment ще не чистий";
  const microText = orderbook >= 60 ? "orderbook підтримує setup" : "5M/orderbook підтвердження ще неповне";
  return `15M ${bias} bias, ${momentumText}; ${smaText}, ${volumeText}, ${microText}. ${signal.rejectionReason}`;
}

function waitingTriggers(signal: Signal, direction: "LONG" | "SHORT") {
  const triggers = direction === "SHORT"
    ? ["✅ повторний rejection від VWAP/SMA50", "✅ MACD bearish cross на 5M", "✅ liquidity sweep над локальним resistance"]
    : ["✅ reclaim VWAP/SMA50 з утриманням", "✅ MACD bullish cross на 5M", "✅ liquidity sweep під локальним support"];
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) triggers.push("✅ volume spike без fake breakout");
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") triggers.push("✅ BTC стабілізується");
  if (signal.fakeBreakout.risk) triggers.push("✅ trap/fake breakout скасовано закриттям 5M");
  return triggers;
}

function potentialLeverage(signal: Signal) {
  if (signal.confidence >= 85) return "x2–x3";
  return "x2 тільки після підтвердження";
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}

function leverageText(signal: Signal) {
  if (signal.positionSizing) return signal.positionSizing.leverage;
  if (signal.leverage?.startsWith("x")) return signal.leverage;
  if (signal.mode !== "futures") return "не використовується";
  const volatility = volatilityFromSignal(signal);
  let leverage = signal.confidence >= 90 ? 5 : signal.confidence >= 87 ? 3 : 2;
  if (volatility === "high") leverage = Math.min(leverage, 2);
  else if (volatility === "medium") leverage = Math.min(leverage, 3);
  if (signal.confidence < 85) leverage = 2;
  return `x${leverage}`;
}

function smartBreakevenText(signal: Signal) {
  const momentum = signal.scoreBreakdown.momentumQuality ?? 0;
  const structure = signal.scoreBreakdown.smcConfirmation ?? 0;
  if (momentum >= 82 && structure >= 45 && signal.marketRegime !== "VOLATILE") return "Після TP1, якщо імпульс слабшає";
  return "Після TP1";
}

function volatilityFromSignal(signal: Signal) {
  if (signal.marketRegime === "VOLATILE" || signal.marketRegime === "NEWS_DRIVEN") return "high";
  if ((signal.scoreBreakdown.regimePenalty ?? 0) >= 18) return "medium";
  return "normal";
}
