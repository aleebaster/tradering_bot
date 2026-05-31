import { config } from "./config";
import type { MarketRegime, PositionSizing, Side } from "./types";

const ALLOWED_LEVERAGE = [2, 3, 5] as const;

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
}

export function calculatePositionSizing(input: PositionSizingInput): PositionSizing | undefined {
  if (input.mode !== "futures") return undefined;
  if (!["LONG", "SHORT"].includes(input.side)) return undefined;
  if (input.score < 85) return undefined;

  const averageEntry = (input.entry[0] + input.entry[1]) / 2;
  if (!isFinitePositive(averageEntry) || !isFinitePositive(input.stopLoss)) return undefined;

  const priceRiskPercent = Math.abs(averageEntry - input.stopLoss) / averageEntry * 100;
  if (!Number.isFinite(priceRiskPercent) || priceRiskPercent <= 0) return undefined;

  const balanceUsdt = config.USER_BALANCE_USDT;
  const maxRiskPercent = input.score >= 90 ? 4 : 3;
  const leverage = chooseLeverage(input, priceRiskPercent, maxRiskPercent);
  const maxLossUsdt = balanceUsdt * maxRiskPercent / 100;
  const fullNotional = balanceUsdt * leverage;
  const maxSafeNotional = maxLossUsdt / (priceRiskPercent / 100);
  const positionSizeUsdt = roundMoney(Math.max(0, Math.min(fullNotional, maxSafeNotional)));
  if (!isFinitePositive(positionSizeUsdt)) return undefined;

  const marginUsdt = roundMoney(positionSizeUsdt / leverage);
  const quantity = roundQuantity(positionSizeUsdt / averageEntry);
  const potentialLossUsdt = roundMoney(quantity * Math.abs(averageEntry - input.stopLoss));
  const potentialProfitUsdt = input.takeProfit.map((tp) => roundMoney(quantity * Math.abs(tp - averageEntry))) as [number, number, number];
  const accountRiskPercent = roundPercent(balanceUsdt > 0 ? potentialLossUsdt / balanceUsdt * 100 : 0);
  const liquidationSafetyPercent = roundPercent(Math.max(0, 100 / leverage - priceRiskPercent));

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
    liquidationSafetyPercent
  };
}

function chooseLeverage(input: PositionSizingInput, priceRiskPercent: number, maxRiskPercent: number) {
  let leverage: typeof ALLOWED_LEVERAGE[number] = input.score >= 90 ? 5 : input.score >= 87 ? 3 : 2;
  if (input.score >= 85 && input.score < 90) leverage = Math.min(leverage, 3) as typeof ALLOWED_LEVERAGE[number];
  if ((input.volatilityPct ?? 0) > 0.018 || input.marketRegime === "VOLATILE" || input.marketRegime === "NEWS_DRIVEN") leverage = 2;
  else if ((input.volatilityPct ?? 0) > 0.012 || (input.momentumScore ?? 100) < 70) leverage = Math.min(leverage, 3) as typeof ALLOWED_LEVERAGE[number];

  for (const candidate of [leverage, 3, 2].filter(uniqueLeverage).sort((a, b) => b - a)) {
    if (candidate * priceRiskPercent <= maxRiskPercent) return candidate;
  }
  return 2;
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

function roundQuantity(value: number) {
  if (value >= 1000) return Math.floor(value);
  if (value >= 1) return Math.floor(value * 1000) / 1000;
  return Math.floor(value * 1_000_000) / 1_000_000;
}
