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

  async setupActivated(signal: Signal, reasons: string[]) {
    const direction = signal.side === "SHORT" ? "SHORT" : "LONG";
    const icon = direction === "SHORT" ? "🔴" : "🟢";
    await this.send([
      `${icon} SETUP ACTIVATED — ${signal.symbol}`,
      "",
      "Статус:",
      "✅ ЗАХОДИТИ ЗАРАЗ",
      "",
      "Напрямок:",
      direction,
      "",
      "Причина активації:",
      ...reasons.map((reason) => `✅ ${reason}`),
      "",
      "Поточний score:",
      `${signal.score}/100`,
      "",
      `🔥 Grade: ${signal.grade}`,
      ...accuracyLines(signal),
      "",
      "Поточна ціна:",
      fmt(signal.currentPrice),
      "",
      "Зона входу:",
      `${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
      "",
      ...positionSizingLines(signal),
      "",
      "Плече:",
      leverageText(signal),
      "",
      "Stop Loss:",
      fmt(signal.stopLoss),
      "",
      "TP1:",
      fmt(signal.takeProfit[0]),
      "",
      "TP2:",
      fmt(signal.takeProfit[1]),
      "",
      "TP3:",
      fmt(signal.takeProfit[2]),
      "",
      "Ймовірність успіху:",
      `${signal.winProbability}%`,
      "",
      "Confidence:",
      `${signal.confidence}%`,
      "",
      "Risk/Reward:",
      signal.riskReward,
      "",
      "Супровід угоди:",
      "",
      "🟢 ENTER NOW",
      "🟡 HOLD POSITION",
      "🟠 MOVE STOP LOSS TO BREAKEVEN",
      "🟠 TAKE PARTIAL PROFIT",
      "🔴 EXIT TRADE NOW"
    ].join("\n"));
  }

  async setupInvalidated(signal: Signal, reasons: string[]) {
    await this.send([`❌ SETUP INVALIDATED — ${signal.symbol}`, "", "Reason:", ...reasons.map((reason) => `• ${reason}`)].join("\n"));
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
  const direction = signal.side === "SHORT" ? "SHORT" : signal.side === "BUY" ? "LONG" : "LONG";
  const icon = direction === "SHORT" ? "🔴" : "🟢";
  return [
    `${icon} ${direction} — ${signal.symbol}`,
    "",
    `🔥 Grade: ${signal.grade}`,
    `⏳ Діє до: ${new Date(signal.expiresAt).toLocaleTimeString("uk-UA")}`,
    "",
    "Статус:",
    signal.entryStatus === "ENTER_NOW" ? "✅ ЗАХОДИТИ ЗАРАЗ" : "⏳ ЧЕКАТИ ЗОНУ ВХОДУ",
    "",
    `📍 Вхід: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    `📍 ${direction === "SHORT" ? "Шортити" : "Купувати"} по: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    ...positionSizingLines(signal),
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    `🎯 TP1: ${fmt(signal.takeProfit[0])}`,
    `🎯 TP2: ${fmt(signal.takeProfit[1])}`,
    `🎯 TP3: ${fmt(signal.takeProfit[2])}`,
    `⚡ Плече: ${leverageText(signal)}`,
    "",
    ...accuracyLines(signal),
    "",
    "Ймовірність:",
    `${signal.winProbability}%`,
    "",
    "Confidence:",
    `${signal.confidence}%`,
    "",
    "Risk/Reward:",
    signal.riskReward,
    "",
    "📌 Коротко:",
    "",
    `Вхід: ${fmt((signal.entry[0] + signal.entry[1]) / 2)}`,
    `SL: ${fmt(signal.stopLoss)}`,
    `TP: ${fmt(signal.takeProfit[0])} / ${fmt(signal.takeProfit[1])} / ${fmt(signal.takeProfit[2])}`,
    `Плече: ${leverageText(signal)}`,
    "",
    "Причина:",
    ...readableReasons(signal)
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
  return [`⚠️ WATCHLIST ONLY — ${signal.symbol}`, "", `🔥 Grade: ${signal.grade}`, `Confidence: ${signal.confidence}%`, `Win probability: ${signal.winProbability}%`, `Score: ${signal.score}/100`, `⏳ Діє до: ${new Date(signal.expiresAt).toLocaleTimeString("uk-UA")}`, "", ...accuracyLines(signal), "", "Причина:", ...reasonBullets(signal), "", "Моніторинг:", "• бот перевіряє сетап кожні 10–15 секунд", "• активація тільки при score >= 85 та покращенні підтверджень"].join("\n");
}

function reasonBullets(signal: Signal) {
  const reasons = signal.rejectionReason ? [signal.rejectionReason, ...signal.reasons] : signal.reasons;
  return reasons.map((reason) => `• ${reason}`);
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}

function money(n: number) {
  return `$${n.toFixed(4).replace(/\.0+$/, "")}`;
}

function positionSizingLines(signal: Signal) {
  const sizing = signal.positionSizing;
  if (!sizing) {
    if (signal.side === "WATCHLIST") return ["💰 Розмір позиції:", "WATCHLIST ONLY — точний вхід буде розрахований після активації score >= 85"];
    return [];
  }
  const action = signal.side === "SHORT" ? "Шортити" : "Купувати";
  return [
    "💰 Баланс:",
    `${sizing.balanceUsdt} USDT`,
    "",
    "⚡ Плече:",
    sizing.leverage,
    "",
    "💵 По скільки входити:",
    `${sizing.marginUsdt} USDT маржа / ${sizing.positionSizeUsdt} USDT позиція`,
    "",
    `📍 ${action} по:`,
    `${fmt(sizing.entryRange[0])}–${fmt(sizing.entryRange[1])}`,
    "",
    "📦 Взяти:",
    `${formatQuantity(sizing.quantity)} ${sizing.baseAsset}`,
    "",
    "📉 Максимальний ризик:",
    `${sizing.accountRiskPercent}% від балансу (ліміт ${sizing.maxRiskPercent}%)`,
    "",
    "💸 Потенційний збиток:",
    money(sizing.potentialLossUsdt),
    "",
    "💰 Потенційний прибуток:",
    `TP1 ${money(sizing.potentialProfitUsdt[0])} / TP2 ${money(sizing.potentialProfitUsdt[1])} / TP3 ${money(sizing.potentialProfitUsdt[2])}`,
    "",
    "🛡 Liquidation safety:",
    sizing.liquidationSafety
  ];
}

function accuracyLines(signal: Signal) {
  return [
    "🧠 Accuracy engine:",
    "🛡 Small balance growth mode: capital preservation first",
    signal.session.message,
    signal.newsRisk.blocked ? signal.newsRisk.message : "✅ High-impact news risk: clean",
    signal.higherTimeframe.executionAligned ? signal.higherTimeframe.counterTrend ? "⚠️ Counter-trend: 1H/15M/5M aligned, 4H/Daily тільки знижують confidence" : "✅ 1H/15M/5M execution aligned" : "⚠️ 1H/15M/5M execution не підтверджений",
    signal.liquidityIntelligence.message,
    signal.orderFlow.message,
    signal.openInterestAnalysis.message,
    signal.fastMoveQuality.message,
    signal.fakeBreakout.risk ? signal.fakeBreakout.message : "✅ Fake breakout risk low",
    signal.correlation.aligned || signal.correlation.riskOff ? `✅ Correlation: ${signal.correlation.details.join("; ")}` : `⚠️ Correlation: ${signal.correlation.details.join("; ")}`
  ];
}

function formatQuantity(value: number) {
  if (value >= 1000) return String(Math.floor(value));
  if (value >= 1) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
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

function volatilityFromSignal(signal: Signal) {
  if (signal.marketRegime === "VOLATILE" || signal.marketRegime === "NEWS_DRIVEN") return "high";
  if ((signal.scoreBreakdown.regimePenalty ?? 0) >= 18) return "medium";
  return "normal";
}

function readableReasons(signal: Signal) {
  const direction = signal.side === "SHORT" ? "bearish trend" : "trend confirmation";
  const reasons = [direction];
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) >= 65) reasons.push("volume confirmation");
  if ((signal.scoreBreakdown.momentumQuality ?? 0) >= 55) reasons.push("momentum confirmation");
  if ((signal.scoreBreakdown.orderBookImbalance ?? 0) >= 60) reasons.push(signal.side === "SHORT" ? "order book pressure" : "order book support");
  if (signal.btcStable) reasons.push("BTC stable");
  if (reasons.length < 4) reasons.push(...signal.reasons.slice(0, 4 - reasons.length));
  return reasons.slice(0, 5).map((reason) => `✅ ${reason}`);
}
