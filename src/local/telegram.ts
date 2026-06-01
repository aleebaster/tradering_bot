import { config } from "./config";
import { logger } from "./logger";
import { loadTelegramSettings, maxLeverageNumber } from "./telegramSettings";
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
    const json = await res.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number; chat?: { id?: number | string } } } | null;
    logger.info({ messageId: json?.result?.message_id, chatId: json?.result?.chat?.id, chars: text.length }, "Telegram response sent");
  }

  isEnabled() {
    return this.enabled;
  }
}

export function signalQuickActions(symbol: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: "🟢 Моніторити", callback_data: `watch:${symbol}` }, { text: "🔄 Оновити Аналіз", callback_data: `refresh:${symbol}` }],
      [{ text: "📖 Детальний аналіз", callback_data: `analyze_futures:${symbol}` }, { text: "🛠 Сирі технічні дані", callback_data: `raw_futures:${symbol}` }],
      [{ text: "❌ Видалити", callback_data: `remove:${symbol}` }]
    ]
  };
}

function modeUa(mode: string) {
  return mode === "LOCAL_ONLY" ? "локальний" : mode === "HYBRID" ? "гібридний" : mode === "OFFLINE_TEST" ? "тест без підключень" : mode;
}

export function formatExecutionSignal(signal: Signal) {
  return formatDecisionSignal(signal);
}

export function formatDecisionSignal(signal: Signal) {
  const direction = setupDirection(signal);
  const canEnter = isRealEntrySignal(signal);
  const entryConfidence = entryConfidenceScore(signal, canEnter);
  const execution = executionPlan(signal, canEnter, entryConfidence);
  return canEnter ? confirmedSignalText(signal, direction, entryConfidence, execution) : potentialSignalText(signal, direction, entryConfidence, execution);
}

function potentialSignalText(signal: Signal, direction: ReturnType<typeof setupDirection>, entryConfidence: number, execution: ReturnType<typeof executionPlan>) {
  const balance = loadTelegramSettings().balanceUsdt;
  const plan = positionPlan(signal, balance);
  return [
    `⚪ СИГНАЛ — ${signal.symbol}`,
    "",
    "📍 ПОТЕНЦІЙНИЙ НАПРЯМОК:",
    `${direction.icon} ${direction.label}`,
    "",
    "❌ ЩЕ НЕ ВХОДИТИ",
    "",
    `Оцінка сетапу: ${signal.score}/100`,
    `Впевненість входу: ${entryConfidence}/100`,
    "",
    `⚡ Виконання: ${executionLabelUa(execution.label)}`,
    executionExplanationLine(execution),
    "",
    `📍 Зона входу: ${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    "",
    ...smallBalanceLines(plan),
    "",
    `⚙️ Маржа: ізольована ${plan.leverage}x`,
    `📦 Розмір позиції: ${formatAmount(plan.positionSizeUsdt)} USDT`,
    `🪙 Кількість: ~${formatQty(plan.qty)} ${baseAsset(signal.symbol)}`,
    "",
    "📌 Тип входу:",
    entryTypeLine(execution),
    "",
    "📈 План TP:",
    "",
    ...tpPlanLines(signal, plan),
    "",
    "🛑 Максимальний збиток:",
    `≈ -${formatAmount(plan.maxLossUsdt)} USDT`,
    `ROI при стопі: -${formatPercent(plan.maxLossRoi)}%`,
    "",
    "⚠️ Ризик: вхід неактивний",
    "",
    "Причина:",
    `${direction.label}: ${executionReasons(signal, false).join(" + ")}`,
    "",
    execution.action
  ].join("\n");
}

function confirmedSignalText(signal: Signal, direction: ReturnType<typeof setupDirection>, entryConfidence: number, execution: ReturnType<typeof executionPlan>) {
  const balance = loadTelegramSettings().balanceUsdt;
  const plan = positionPlan(signal, balance);
  return [
    `🚨 СИГНАЛ — ${signal.symbol}`,
    "",
    "📍 НАПРЯМОК:",
    `${direction.icon} ${direction.label}`,
    "",
    "✅ МОЖНА ВХОДИТИ",
    "",
    `Оцінка сетапу: ${signal.score}/100`,
    `Впевненість входу: ${entryConfidence}/100`,
    "",
    `⚡ Виконання: ${executionLabelUa(execution.label)}`,
    executionExplanationLine(execution),
    "",
    execution.label === "LIMIT ENTRY" ? "📍 Лімітна заявка:" : "📍 Вхід:",
    `${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`,
    "",
    `Кількість: ~${formatQty(plan.qty)} ${baseAsset(signal.symbol)} (від банку ${formatAmount(balance)} USDT)`,
    `⚙️ Маржа: ізольована ${plan.leverage}x`,
    `📦 Розмір позиції: ${formatAmount(plan.positionSizeUsdt)} USDT`,
    "",
    `🛑 SL: ${fmt(signal.stopLoss)}`,
    "",
    ...tpPlanLines(signal, plan),
    "",
    ...smallBalanceLines(plan),
    `⚠️ Ризик: ~${formatAmount(plan.maxLossUsdt)} USDT`,
    `🛑 Максимальний збиток: -${formatAmount(plan.maxLossUsdt)} USDT (${formatPercent(plan.maxLossRoi)}% ROI)`,
    `⚖️ RR: ${signal.riskReward}`,
    "",
    "Причина:",
    `${direction.label}: ${executionReasons(signal, true).join(" + ")}`,
    "",
    execution.action
  ].join("\n");
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
    && signal.confidence >= 60
    && inEntryZone
    && (signal.btcStable || signal.symbol === "BTCUSDT")
    && signal.higherTimeframe.executionAligned
    && enoughConfirmations
    && !signal.fakeBreakout.risk
    && !signal.newsRisk.blocked
    && rrNumber(signal.riskReward) >= 2;
}

function entryConfidenceScore(signal: Signal, canEnter: boolean) {
  const breakdown = signal.scoreBreakdown ?? {};
  const raw = Math.round(
    (signal.confidence || 0) * 0.25
    + (breakdown.entrySniper ?? 0) * 0.2
    + (breakdown.liquiditySweep ?? 0) * 0.18
    + (breakdown.volumeConfirmation ?? 0) * 0.15
    + (breakdown.momentumQuality ?? 0) * 0.12
    + (signal.higherTimeframe.executionAligned ? 10 : 0)
  );
  const penalties = (signal.entryStatus !== "ENTER_NOW" ? 18 : 0) + (signal.fakeBreakout.risk ? 25 : 0) + (!signal.btcStable && signal.symbol !== "BTCUSDT" ? 10 : 0);
  return canEnter ? Math.max(75, Math.min(96, raw)) : Math.max(5, Math.min(59, raw - penalties));
}

function executionPlan(signal: Signal, canEnter: boolean, entryConfidence: number) {
  const breakdown = signal.scoreBreakdown ?? {};
  if (!canEnter) return { label: "WAIT FOR RETEST", action: "➡️ зараз НЕ заходити", explanation: "вхід ще не підтверджений: чекаємо ретест, обсяг і sniper-підтвердження" } as const;
  const market = (breakdown.fastMoveQuality ?? signal.fastMoveQuality?.score ?? 0) >= 78
    && (breakdown.momentumQuality ?? 0) >= 82
    && (breakdown.volumeConfirmation ?? 0) >= 80
    && (breakdown.entrySniper ?? 0) >= 85
    && entryConfidence >= 85;
  if (market) return { label: "MARKET ENTRY", action: "➡️ заходити по ринку", explanation: "сильний імпульс + обсяг + sniper, ціна вже в зоні входу" } as const;
  return { label: "LIMIT ENTRY", action: "➡️ поставити лімітний ордер", explanation: "сетап підтверджений, але краще забрати відкат у заданій зоні входу" } as const;
}

function setupDirection(signal: Signal) {
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const tp1 = signal.takeProfit[0];
  if (tp1 > avgEntry && signal.stopLoss < avgEntry) return { label: "LONG", icon: "🟢" };
  if (tp1 < avgEntry && signal.stopLoss > avgEntry) return { label: "SHORT", icon: "🔴" };
  if (signal.side === "SHORT") return { label: "SHORT", icon: "🔴" };
  return { label: "LONG", icon: "🟢" };
}

function executionReasons(signal: Signal, canEnter: boolean) {
  const breakdown = signal.scoreBreakdown;
  const positive = [
    (breakdown.momentumQuality ?? 0) >= 70 ? "імпульс підтверджений" : null,
    (breakdown.openInterestConfirmation ?? 0) >= 65 ? "OI підтверджує" : null,
    (breakdown.volumeConfirmation ?? 0) >= 65 ? "обсяг підтверджує" : null,
    (breakdown.entrySniper ?? 0) >= 70 ? "sniper-тригер" : null,
    signal.btcStable || signal.symbol === "BTCUSDT" ? "BTC стабільний" : null,
    (breakdown.liquiditySweep ?? 0) >= 65 ? "ретест підтверджений" : null
  ].filter(Boolean) as string[];
  const blockers = [
    signal.entryStatus !== "ENTER_NOW" ? "очікування підтвердження" : null,
    !canEnter ? "виконання не підтверджене" : null,
    (breakdown.volumeConfirmation ?? 0) < 65 ? "слабкий обсяг" : null,
    (breakdown.entrySniper ?? 0) < 70 ? "немає sniper-тригера" : null,
    (breakdown.liquiditySweep ?? 0) < 65 ? "немає підтвердження ретесту" : null,
    !signal.btcStable && signal.symbol !== "BTCUSDT" ? "BTC нестабільний" : null,
    signal.fakeBreakout.risk ? "ризик fake breakout" : null,
    signal.confidence < 60 ? "впевненість нижче 60%" : null
  ].filter(Boolean) as string[];
  if (!canEnter) return blockers.slice(0, 5);
  return [...positive, ...blockers.filter((reason) => !positive.includes(reason))].slice(0, 5);
}

function tpSplit(_signal: Signal) {
  return [40, 30, 20];
}

function positionPlan(signal: Signal, balance: number) {
  const existing = signal.positionSizing;
  if (existing) {
    const leverage = Number(existing.leverage.replace("x", ""));
    const maxLossUsdt = existing.potentialLossUsdt;
    return {
      balance: existing.balanceUsdt,
      leverage,
      positionSizeUsdt: existing.positionSizeUsdt,
      qty: existing.quantity,
      maxLossUsdt,
      maxLossRoi: roi(maxLossUsdt, existing.marginUsdt),
      split: tpSplit(signal),
      marginUsdt: existing.marginUsdt,
      tpProfits: existing.potentialProfitUsdt,
      roiByTp: existing.potentialProfitUsdt.map((profit) => roi(profit, existing.marginUsdt))
    };
  }
  const leverage = Math.min(maxLeverageNumber(), balance <= 10 ? 2 : maxLeverageNumber());
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const positionSizeUsdt = balance * leverage;
  const marginUsdt = leverage > 0 ? positionSizeUsdt / leverage : balance;
  const qty = avgEntry > 0 ? positionSizeUsdt / avgEntry : 0;
  const maxLoss = maxLossUsdt(signal, qty);
  const split = tpSplit(signal);
  const tpProfits = signal.takeProfit.map((tp, index) => tpProfitUsdt(signal, qty, split[index] ?? 0, tp));
  return { balance, leverage, positionSizeUsdt, qty, maxLossUsdt: maxLoss, maxLossRoi: roi(maxLoss, marginUsdt), split, marginUsdt, tpProfits, roiByTp: tpProfits.map((profit) => roi(profit, marginUsdt)) };
}

function tpPlanLines(signal: Signal, plan: ReturnType<typeof positionPlan>) {
  return signal.takeProfit.flatMap((tp, index) => {
    const pct = plan.split[index] ?? 0;
    const profit = plan.tpProfits[index] ?? tpProfitUsdt(signal, plan.qty, pct, tp);
    return [`🎯 TP${index + 1}: ${fmt(tp)}`, `Закрити: ${pct}%`, `≈ +${formatAmount(profit)} USDT (${formatPercent(plan.roiByTp[index] ?? 0)}% ROI)`, ""];
  }).slice(0, -1);
}

function tpProfitUsdt(signal: Signal, qty: number, pct: number, tp: number) {
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  return Math.max(0, Math.abs(tp - avgEntry) * qty * pct / 100);
}

function maxLossUsdt(signal: Signal, qty: number) {
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  return Math.max(0, Math.abs(avgEntry - signal.stopLoss) * qty);
}

function entryTypeLine(execution: ReturnType<typeof executionPlan>) {
  if (execution.label === "MARKET ENTRY") return "🟢 Вхід по ринку";
  if (execution.label === "LIMIT ENTRY") return "🟡 Очікуємо лімітний вхід";
  return "⚪ Очікування ретесту";
}

function executionLabelUa(label: ReturnType<typeof executionPlan>["label"]) {
  if (label === "MARKET ENTRY") return "Вхід по ринку";
  if (label === "LIMIT ENTRY") return "Очікуємо лімітний вхід";
  return "Очікування ретесту";
}

function executionExplanationLine(execution: ReturnType<typeof executionPlan>) {
  return `${entryTypeLine(execution)} — ${execution.explanation}`;
}

function smallBalanceLines(plan: ReturnType<typeof positionPlan>) {
  return [
    `💰 Режим малого банку: ${formatAmount(plan.balance)} USDT`,
    `💵 Маржа: ${formatAmount(plan.marginUsdt)} USDT`,
    `📦 Розмір позиції: ${formatAmount(plan.positionSizeUsdt)} USDT`,
    `🪙 Кількість монет: ~${formatQty(plan.qty)}`,
    `⚠️ Ризик: ${formatAmount(plan.maxLossUsdt)} USDT`,
    `📊 ROI ризик: ${formatPercent(plan.maxLossRoi)}%`
  ];
}

function roi(value: number, margin: number) {
  return margin > 0 ? value / margin * 100 : 0;
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

function formatAmount(value: number) {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number) {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function baseAsset(symbol: string) {
  return symbol.replace(/USDT$/i, "").replace(/^1000/, "");
}

function formatQty(value: number) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
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
