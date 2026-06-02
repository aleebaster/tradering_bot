import { config } from "./config";
import { conservativeModeActive } from "./lossProtection";
import { loadTelegramSettings, maxLeverageNumber, riskMultiplier } from "./telegramSettings";
import type { MarketRegime, PositionSizing, Side } from "./types";

const ALLOWED_LEVERAGE = [2, 3] as const;
const BYBIT_ROUND_TRIP_TAKER_FEE_PERCENT = 0.11;

export interface PositionSizingInput {
  symbol: string;
  mode: "spot" | "futures";
  side: Side;
  score: number;
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  marketRegime?: MarketRegime;
  volatilityPct?: number;
  momentumScore?: number;
  volumeScore?: number;
  btcStable?: boolean;
  orderFlowScore?: number;
  sniperConfidence?: number;
  fakeBreakoutRisk?: boolean;
  marginMode?: "ISOLATED" | "CROSS";
}

export function calculatePositionSizing(input: PositionSizingInput): PositionSizing | undefined {
  if (input.mode !== "futures") return undefined;
  if (!["LONG", "SHORT"].includes(input.side)) return undefined;
  if (input.score < 85) return undefined;

  const averageEntry = (input.entry[0] + input.entry[1]) / 2;
  if (!isFinitePositive(averageEntry) || !isFinitePositive(input.stopLoss)) return undefined;

  const priceRiskPercent = Math.abs(averageEntry - input.stopLoss) / averageEntry * 100;
  if (!Number.isFinite(priceRiskPercent) || priceRiskPercent <= 0) return undefined;

  const balanceUsdt = loadTelegramSettings().balanceUsdt;
  const marginMode = detectedMarginMode(input.marginMode);
  const maxRiskPercent = maxRiskPercentFor(input.score);
  const leverage = chooseLeverage(input, priceRiskPercent, maxRiskPercent, marginMode);
  const maxLossUsdt = balanceUsdt * maxRiskPercent / 100;
  const marginRiskFactor = marginMode === "CROSS" ? 0.6 : 1;
  const fullNotional = balanceUsdt * leverage * marginRiskFactor;
  const maxSafeNotional = maxLossUsdt / (priceRiskPercent / 100);
  const starterEntry = balanceUsdt <= 15 && input.score >= 88;
  const starterFactor = starterEntry ? balanceUsdt <= 5.5 ? 0.5 : 0.75 : 1;
  const positionSizeUsdt = roundMoney(Math.max(0, Math.min(fullNotional, maxSafeNotional)) * starterFactor);
  if (!isFinitePositive(positionSizeUsdt)) return undefined;

  const marginUsdt = roundMoney(positionSizeUsdt / leverage);
  const quantity = roundQuantity(positionSizeUsdt / averageEntry);
  const potentialLossUsdt = roundMoney(quantity * Math.abs(averageEntry - input.stopLoss));
  const potentialProfitUsdt = input.takeProfit.map((tp) => roundMoney(quantity * Math.abs(tp - averageEntry))) as [number, number, number];
  const accountRiskPercent = roundPercent(balanceUsdt > 0 ? potentialLossUsdt / balanceUsdt * 100 : 0);
  const liquidationSafetyPercent = roundPercent(Math.max(0, 100 / leverage - priceRiskPercent));
  const breakeven = breakevenPlus(input, averageEntry, leverage, balanceUsdt <= 15);
  const profitProtection = smartProfitProtection(input, balanceUsdt <= 20);

  return {
    balanceUsdt,
    marginUsdt,
    leverage: `x${leverage}` as PositionSizing["leverage"],
    positionSizeUsdt,
    quantity,
    baseAsset: baseAsset(input.symbol),
    entryRange: input.entry,
    averageEntry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    maxRiskPercent,
    accountRiskPercent,
    priceRiskPercent: roundPercent(priceRiskPercent),
    potentialLossUsdt,
    potentialProfitUsdt,
    liquidationSafety: liquidationSafetyText(liquidationSafetyPercent, leverage),
    liquidationSafetyPercent,
    marginMode,
    riskMode: input.score >= 95 && marginMode === "ISOLATED" && (input.btcStable ?? true) ? "aggressive" : "safe",
    breakevenPlusPrice: breakeven.price,
    breakevenPlusOffsetPercent: breakeven.offsetPercent,
    breakevenPlusNetBufferPercent: breakeven.netBufferPercent,
    breakevenPlusFeePercent: BYBIT_ROUND_TRIP_TAKER_FEE_PERCENT,
    breakevenTrigger: "TP1",
    breakevenAction: breakeven.action,
    breakevenActivationRule: breakeven.activationRule,
    breakevenDelay: breakeven.delay,
    breakevenContinuationMode: breakeven.continuationMode,
    antiShakeoutRule: breakeven.antiShakeoutRule,
    profitProtectionMode: profitProtection.mode,
    tp1ClosePercent: profitProtection.tp1ClosePercent,
    tp2ClosePercent: profitProtection.tp2ClosePercent,
    runnerPercent: profitProtection.runnerPercent,
    runnerAllowed: profitProtection.runnerAllowed,
    tp2ProtectionAction: profitProtection.tp2Action,
    trailingStopRule: profitProtection.trailingStopRule,
    runnerTrailingRule: profitProtection.runnerTrailingRule,
    runnerAutoKillRule: profitProtection.runnerAutoKillRule,
    antiGivebackRule: profitProtection.antiGivebackRule,
    maxProfitGivebackPercent: profitProtection.maxGivebackPercent,
    trendProtectionRule: profitProtection.trendRule,
    protectiveStopRequired: true,
    marginProtection: marginProtectionText(marginMode),
    entryPlan: starterEntry ? "50% starter entry, add only after confirmation" : "single confirmed entry",
    starterEntryPercent: starterEntry ? 50 : 100,
    addOnRule: starterEntry ? "Add remaining 50% only after volume/retest/sniper confirmation holds." : undefined
  };
}

function chooseLeverage(input: PositionSizingInput, priceRiskPercent: number, maxRiskPercent: number, marginMode: "ISOLATED" | "CROSS") {
  const smallAccount = loadTelegramSettings().balanceUsdt <= 15;
  let leverage: typeof ALLOWED_LEVERAGE[number] = smallAccount ? input.score >= 95 ? 3 : 2 : input.score >= 92 ? 3 : 2;
  leverage = Math.min(leverage, Math.min(maxLeverageNumber(), 3)) as typeof ALLOWED_LEVERAGE[number];
  if (smallAccount && input.score < 95) leverage = 2;
  if (marginMode === "CROSS") leverage = Math.min(leverage, 2) as typeof ALLOWED_LEVERAGE[number];
  if (config.smallBalanceGrowthMode && input.score < 92) leverage = Math.min(leverage, 3) as typeof ALLOWED_LEVERAGE[number];
  if (conservativeModeActive()) leverage = Math.min(leverage, 2) as typeof ALLOWED_LEVERAGE[number];
  if (input.score >= 85 && input.score < 90) leverage = Math.min(leverage, 3) as typeof ALLOWED_LEVERAGE[number];
  if ((input.volatilityPct ?? 0) > 0.018 || input.marketRegime === "VOLATILE" || input.marketRegime === "NEWS_DRIVEN") leverage = 2;
  else if ((input.volatilityPct ?? 0) > 0.012 || (input.momentumScore ?? 100) < 70) leverage = Math.min(leverage, 3) as typeof ALLOWED_LEVERAGE[number];

  for (const candidate of [leverage, 3, 2].filter(uniqueLeverage).sort((a, b) => b - a)) {
    if (candidate * priceRiskPercent <= maxRiskPercent) return candidate;
  }
  return 2;
}

export function smartProfitProtection(input: Pick<PositionSizingInput, "marketRegime" | "volatilityPct" | "momentumScore" | "volumeScore" | "btcStable" | "orderFlowScore" | "sniperConfidence" | "fakeBreakoutRisk">, smallAccount = false) {
  const volatilityPct = Math.max(0, input.volatilityPct ?? 0);
  const choppy = input.marketRegime === "SIDEWAYS" || input.marketRegime === "CHOPPY" || input.marketRegime === "RANGING" || input.marketRegime === "LOW_VOLATILITY";
  const trendRegime = input.marketRegime === "TRENDING" || input.marketRegime === "BREAKOUT" || input.marketRegime === "EXPANSION";
  const highVolatility = volatilityPct >= 0.018 || input.marketRegime === "HIGH_VOLATILITY" || input.marketRegime === "VOLATILE";
  const noExhaustion = !input.fakeBreakoutRisk && !highVolatility;
  const strongContinuation = trendRegime && noExhaustion && (input.momentumScore ?? 0) >= 82 && (input.volumeScore ?? 0) >= 78 && (input.orderFlowScore ?? 0) >= 70 && (input.sniperConfidence ?? 0) >= 75 && input.btcStable !== false;
  const weakContinuation = (input.momentumScore ?? 100) < 70 || (input.volumeScore ?? 100) < 65 || (input.orderFlowScore ?? 100) < 60 || input.btcStable === false || choppy || input.fakeBreakoutRisk === true;
  const runnerAllowed = strongContinuation;
  const mode: "trail" | "tighten" = runnerAllowed ? "trail" : "tighten";
  const tp1ClosePercent = smallAccount ? runnerAllowed ? 35 : 50 : runnerAllowed ? 40 : 50;
  const runnerPercent = runnerAllowed ? smallAccount ? 15 : 25 : 0;
  const tp2ClosePercent = Math.max(0, 100 - tp1ClosePercent - runnerPercent);
  const trailingStopRule = mode === "trail"
    ? `${highVolatility ? "Wide" : "Normal"} ATR/structure trail after TP2; do not aggressively tighten while momentum/orderflow/BTC remain supportive.`
    : "Tighten after TP2 because continuation is weak/choppy; protect realized profit before runner.";
  const tp2Action = mode === "trail"
    ? "TP2 hit with strong continuation -> keep runner and trail below structure/ATR/volatility."
    : "TP2 hit with weak continuation -> close additional size and tighten faster.";
  const runnerTrailingRule = runnerAllowed
    ? `${highVolatility ? "Wide" : "Adaptive"} runner trail: ATR + structure lows/highs + volatility; tighten on momentum decay or orderflow weakening.`
    : "No runner: trend quality is not high enough; close planned size by TP2.";
  const runnerAutoKillRule = "Auto-close runner on BTC instability, sharp momentum collapse, fake-breakout signs, strong reversal candle, or volatility spike against the trade.";
  const antiGivebackRule = "After strong unrealized profit, never allow more than 50% giveback from peak; ratchet stop dynamically as peak profit expands.";
  const trendRule = choppy
    ? "Choppy/sideways: tighter protection and smaller/no runner."
    : strongContinuation
      ? "Strong trend: wider trailing stop to avoid cutting runner too early."
      : "Mixed trend: protect capital first, use tighter trail.";
  return { mode, tp1ClosePercent, tp2ClosePercent, runnerPercent, runnerAllowed, trailingStopRule, runnerTrailingRule, runnerAutoKillRule, tp2Action, antiGivebackRule, maxGivebackPercent: 50, trendRule };
}

export function breakevenPlus(input: Pick<PositionSizingInput, "side" | "volatilityPct" | "momentumScore" | "volumeScore" | "btcStable" | "orderFlowScore" | "sniperConfidence">, averageEntry: number, leverage: number, smallAccount = false) {
  const volatilityPct = Math.max(0, input.volatilityPct ?? 0);
  const weakMomentum = (input.momentumScore ?? 100) < 70 || (input.volumeScore ?? 100) < 65 || input.btcStable === false || (input.orderFlowScore ?? 100) < 60 || (input.sniperConfidence ?? 100) < 70;
  const strongMomentum = !weakMomentum && (input.momentumScore ?? 0) >= 82 && (input.volumeScore ?? 0) >= 78 && (input.orderFlowScore ?? 0) >= 70 && (input.sniperConfidence ?? 0) >= 82;
  const highVolatility = volatilityPct >= 0.018;
  const mediumVolatility = volatilityPct >= 0.012;
  const leverageBuffer = leverage >= 3 ? 0.05 : 0;
  const volatilityBuffer = highVolatility ? 0.1 : mediumVolatility ? 0.06 : 0;
  const weaknessBuffer = weakMomentum ? 0.04 : 0;
  const netBufferPercent = roundPercent(Math.min(0.35, Math.max(0.15, 0.15 + leverageBuffer + volatilityBuffer + weaknessBuffer)));
  const offsetPercent = roundPercent(BYBIT_ROUND_TRIP_TAKER_FEE_PERCENT + netBufferPercent);
  const side = input.side === "SHORT" ? "SHORT" : "LONG";
  const price = side === "SHORT" ? averageEntry * (1 - offsetPercent / 100) : averageEntry * (1 + offsetPercent / 100);
  const continuationMode: "delay" | "normal" | "tighten" = strongMomentum && !smallAccount ? "delay" : weakMomentum || smallAccount ? "tighten" : "normal";
  const activationRule = "Do not move on first TP1 wick. Activate only after TP1 touch holds/retests, a candle closes beyond TP1, or post-TP1 momentum stays strong.";
  const delay = highVolatility
    ? "High volatility: wait one extra confirmation candle or sustained post-TP1 momentum before BE+."
    : mediumVolatility
      ? "Medium volatility: confirm TP1 hold/close before BE+."
      : "Low volatility: normal TP1 hold/close confirmation is enough.";
  const continuation = continuationMode === "delay"
    ? "Strong continuation: allow breathing room toward TP2 before tightening."
    : continuationMode === "tighten"
      ? "Weak continuation or small account: tighten after confirmation, not on the first wick."
      : "Normal continuation: activate after TP1 confirmation.";
  const antiShakeoutRule = "Never move BE+ into an obvious TP1 wick/liquidity-sweep zone; wait for hold, close, or continuation confirmation.";
  return { price: roundPrice(price), offsetPercent, netBufferPercent, continuationMode, activationRule, delay, antiShakeoutRule, action: `TP1 confirmation -> move SL to BE+ ${roundPrice(price)} (${continuation}; fees protected)` };
}

function detectedMarginMode(input?: "ISOLATED" | "CROSS") {
  const raw = input ?? process.env.BYBIT_MARGIN_MODE;
  return String(raw ?? "ISOLATED").toUpperCase() === "CROSS" ? "CROSS" : "ISOLATED";
}

function marginProtectionText(marginMode: "ISOLATED" | "CROSS") {
  if (marginMode === "CROSS") return "CROSS margin: strict protection enabled; position-specific SL required immediately; never rely on account liquidation.";
  return "ISOLATED margin: preferred mode; position-specific SL remains required.";
}

function maxRiskPercentFor(score: number) {
  const multiplier = riskMultiplier();
  if (!config.smallBalanceGrowthMode) return (score >= 90 ? 4 : 3) * multiplier;
  if (score >= 94) return 2 * multiplier;
  if (score >= 90) return 1.5 * multiplier;
  return 1.25 * multiplier;
}

function uniqueLeverage(value: number, index: number, arr: number[]) {
  return ALLOWED_LEVERAGE.includes(value as typeof ALLOWED_LEVERAGE[number]) && arr.indexOf(value) === index;
}

function baseAsset(symbol: string) {
  return symbol.replace(/USDT$/i, "").replace(/USD$/i, "");
}

function liquidationSafetyText(safetyPercent: number, leverage: number) {
  if (safetyPercent >= 12) return `безпечний запас ~${safetyPercent.toFixed(2)}% до орієнтовної ліквідації при x${leverage}`;
  if (safetyPercent >= 6) return `середній запас ~${safetyPercent.toFixed(2)}% до орієнтовної ліквідації при x${leverage}`;
  return `низький запас ~${safetyPercent.toFixed(2)}% до орієнтовної ліквідації, ризик зменшено розміром позиції`;
}

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function roundMoney(value: number) {
  return Math.round(value * 10000) / 10000;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPrice(value: number) {
  if (value >= 100) return Math.round(value * 100) / 100;
  if (value >= 1) return Math.round(value * 100000) / 100000;
  return Math.round(value * 100000000) / 100000000;
}

function roundQuantity(value: number) {
  if (value >= 1000) return Math.floor(value);
  if (value >= 1) return Math.floor(value * 1000) / 1000;
  return Math.floor(value * 1_000_000) / 1_000_000;
}
