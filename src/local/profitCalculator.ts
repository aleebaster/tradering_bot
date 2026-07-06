import { ExchangeClient } from "./exchanges";
import { config } from "./config";
import { calculateFees } from "./feeEngine";
import { logger } from "./logger";
import type { Signal } from "./types";

export interface ProfitReport {
  entryPrice: number;
  positionValueUsdt: number;
  grossProfit: number;
  grossLoss: number;
  fees: {
    takerFeeRate: number;
    makerFeeRate: number;
    entryFee: number;
    exitFee: number;
    totalFees: number;
  };
  slippageEstimate: number;
  fundingEstimate: number;
  netProfit: number;
  netLoss: number;
  rrRaw: number;
  rrAfterFees: number;
  profitFeeRatio: number;
  slDistancePct: number;
  slDistanceAtr: number;
  tpCanIncrease: boolean;
  tpIncreaseReason: string;
  requiredProfit: number;
  profitPercent: number;
  netProfitPercent: number;
  breakevenPrice: number;
  breakevenDistance: number;
  safetyMargin: number;
  holdHours: number;
  profitPerHour: number;
  passed: {
    netProfit: boolean;
    rrAfterFees: boolean;
    profitFeeRatio: boolean;
    minSlDistance: boolean;
  };
  rejectReason: string;
}

export async function analyzeProfitability(
  client: ExchangeClient,
  signal: Signal,
  qty: number
): Promise<ProfitReport> {
  const long = signal.side === "LONG" || signal.side === "BUY";
  const entryPrice = signal.currentPrice;
  const tp1 = signal.takeProfit[0];
  const sl = signal.stopLoss;

  const positionValueUsdt = qty * entryPrice;
  if (positionValueUsdt <= 0 || qty <= 0) {
    return rejectReport("zero position value");
  }

  const grossProfit = long ? (tp1 - entryPrice) * qty : (entryPrice - tp1) * qty;
  const grossLoss = long ? (entryPrice - sl) * qty : (sl - entryPrice) * qty;

  const feeBreakdown = await calculateFees(client, signal.symbol, positionValueUsdt, true);
  const orderBook = await client.bybitOrderBookStats(signal.symbol).catch(() => ({ spreadPct: 0, depthUsdt: 0, imbalance: 0, spoofRisk: false }));
  const fundingRate = await client.fundingRate(signal.symbol).catch(() => 0);

  const slippageEstimate = (orderBook.spreadPct / 100) * positionValueUsdt * 2;

  const holdHours = parseHoldTime(signal.holdTime);
  const fundingEstimate = Math.abs(fundingRate) * positionValueUsdt * Math.min(holdHours, 8) / 8;

  const netProfit = grossProfit - feeBreakdown.totalFees - slippageEstimate - fundingEstimate;
  const netLoss = grossLoss + feeBreakdown.totalFees + slippageEstimate + fundingEstimate;

  const rrRaw = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const rrAfterFees = netLoss > 0 ? netProfit / netLoss : 0;
  const profitFeeRatio = feeBreakdown.totalFees > 0 ? grossProfit / feeBreakdown.totalFees : 99;

  const profitPercent = positionValueUsdt > 0 ? (grossProfit / positionValueUsdt) * 100 : 0;
  const netProfitPercent = positionValueUsdt > 0 ? (netProfit / positionValueUsdt) * 100 : 0;

  const totalCost = feeBreakdown.totalFees + slippageEstimate + fundingEstimate;
  const breakevenPrice = long ? entryPrice + (totalCost / qty) : entryPrice - (totalCost / qty);
  const breakevenDistance = Math.abs(breakevenPrice - entryPrice);

  const requiredProfit = Math.max(
    positionValueUsdt * (config.minNetProfitPercent / 100),
    config.minNetProfitUsdt
  );

  const safetyMargin = requiredProfit > 0 ? netProfit / requiredProfit : 0;
  const profitPerHour = holdHours > 0 ? netProfit / holdHours : netProfit;

  const candles = await client.bybitKlines(signal.symbol, "5", "linear", 20).catch(() => []);
  const atr = candles.length > 14 ? calcATR(candles, 14) : 0;
  const slDistance = long ? (entryPrice - sl) : (sl - entryPrice);
  const slDistancePct = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
  const slDistanceAtr = atr > 0 ? slDistance / atr : 0;

  const { tpCanIncrease, tpIncreaseReason } = await checkTpCanIncrease(client, signal, orderBook, candles, long);

  const passed = {
    netProfit: netProfit >= requiredProfit,
    rrAfterFees: rrAfterFees >= config.minRrAfterFees,
    profitFeeRatio: profitFeeRatio >= config.minProfitFeeRatio,
    minSlDistance: slDistanceAtr >= config.minSlDistanceAtr
  };

  const failures: string[] = [];
  if (!passed.netProfit) failures.push(`net profit ${netProfit.toFixed(4)} USDT < required ${requiredProfit.toFixed(4)} USDT`);
  if (!passed.rrAfterFees) failures.push(`RR after fees ${rrAfterFees.toFixed(2)} < min ${config.minRrAfterFees}`);
  if (!passed.profitFeeRatio) failures.push(`profit/fee ratio ${profitFeeRatio.toFixed(1)}x < min ${config.minProfitFeeRatio}x`);
  if (!passed.minSlDistance) failures.push(`SL distance ${slDistanceAtr.toFixed(2)} ATR < min ${config.minSlDistanceAtr} ATR`);

  return {
    entryPrice,
    positionValueUsdt,
    grossProfit,
    grossLoss,
    fees: {
      takerFeeRate: feeBreakdown.takerFeeRate,
      makerFeeRate: feeBreakdown.makerFeeRate,
      entryFee: feeBreakdown.entryFee,
      exitFee: feeBreakdown.exitFee,
      totalFees: feeBreakdown.totalFees
    },
    slippageEstimate,
    fundingEstimate,
    netProfit,
    netLoss,
    rrRaw,
    rrAfterFees,
    profitFeeRatio,
    slDistancePct,
    slDistanceAtr,
    tpCanIncrease,
    tpIncreaseReason,
    requiredProfit,
    profitPercent,
    netProfitPercent,
    breakevenPrice,
    breakevenDistance,
    safetyMargin,
    holdHours,
    profitPerHour,
    passed,
    rejectReason: failures.length ? failures.join("; ") : ""
  };
}

function rejectReport(reason: string): ProfitReport {
  return {
    entryPrice: 0, positionValueUsdt: 0,
    grossProfit: 0, grossLoss: 0,
    fees: { takerFeeRate: 0, makerFeeRate: 0, entryFee: 0, exitFee: 0, totalFees: 0 },
    slippageEstimate: 0, fundingEstimate: 0,
    netProfit: 0, netLoss: 0,
    rrRaw: 0, rrAfterFees: 0, profitFeeRatio: 0,
    slDistancePct: 0, slDistanceAtr: 0,
    tpCanIncrease: false, tpIncreaseReason: "",
    requiredProfit: 0, profitPercent: 0, netProfitPercent: 0,
    breakevenPrice: 0, breakevenDistance: 0,
    safetyMargin: 0, holdHours: 0, profitPerHour: 0,
    passed: { netProfit: false, rrAfterFees: false, profitFeeRatio: false, minSlDistance: false },
    rejectReason: reason
  };
}

function parseHoldTime(holdTime: string): number {
  const match = holdTime.match(/(\d+)\s*h/i);
  if (match) return Number(match[1]);
  const minMatch = holdTime.match(/(\d+)\s*m/i);
  if (minMatch) return Number(minMatch[1]) / 60;
  return 2;
}

function calcATR(candles: { high: number; low: number; close: number }[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / Math.max(trs.length, 1);
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

async function checkTpCanIncrease(
  _client: ExchangeClient,
  _signal: Signal,
  orderBook: { spreadPct: number; depthUsdt: number; imbalance: number; spoofRisk: boolean },
  _candles: { high: number; low: number; close: number }[],
  _long: boolean
): Promise<{ tpCanIncrease: boolean; tpIncreaseReason: string }> {
  if (orderBook.depthUsdt < 50000) return { tpCanIncrease: false, tpIncreaseReason: "low order book depth" };
  if (_candles.length < 5) return { tpCanIncrease: false, tpIncreaseReason: "insufficient candles" };
  return { tpCanIncrease: true, tpIncreaseReason: "sufficient liquidity and momentum" };
}

export function logProfitReport(report: ProfitReport): void {
  const lines = [
    "",
    "=================================================",
    "PROFIT ANALYSIS",
    "=================================================",
    "",
    `Position Size        ${report.positionValueUsdt.toFixed(2)} USDT`,
    `Required Profit      ${report.requiredProfit.toFixed(4)} USDT  (${(config.minNetProfitPercent).toFixed(1)}% of pos | min ${config.minNetProfitUsdt.toFixed(2)} USDT)`,
    "",
    `Gross Profit         ${report.grossProfit.toFixed(4)} USDT  (${report.profitPercent.toFixed(2)}%)`,
    `Fees                 ${report.fees.totalFees.toFixed(4)} USDT  (taker ${(report.fees.takerFeeRate * 100).toFixed(3)}%)`,
    `Funding              ${report.fundingEstimate.toFixed(4)} USDT`,
    `Slippage             ${report.slippageEstimate.toFixed(4)} USDT`,
    `─────────────────────────────────────────────────`,
    `Net Profit           ${report.netProfit.toFixed(4)} USDT  (${report.netProfitPercent.toFixed(2)}%)`,
    `Net Loss (if SL)     ${report.netLoss.toFixed(4)} USDT`,
    "",
    `RR raw               ${report.rrRaw.toFixed(2)}`,
    `RR after fees        ${report.rrAfterFees.toFixed(2)}`,
    `Profit / Fee ratio   ${report.profitFeeRatio.toFixed(1)}x`,
    `Safety Margin        ${report.safetyMargin.toFixed(2)}x`,
    "",
    `Break-even Price     ${report.breakevenPrice.toFixed(6)}  (dist ${report.breakevenDistance.toFixed(6)})`,
    `SL distance          ${report.slDistancePct.toFixed(2)}% / ${report.slDistanceAtr.toFixed(2)} ATR`,
    `Expected Hold        ${report.holdHours.toFixed(1)}h  (${report.profitPerHour.toFixed(4)} USDT/h)`,
    "",
    `TP can increase      ${report.tpCanIncrease ? "YES" : "NO"}  (${report.tpIncreaseReason})`,
    "",
    `Result               ${report.rejectReason ? "FAIL" : "PASS"}`,
    ...(report.rejectReason ? [`Reason               ${report.rejectReason}`] : []),
    "=================================================",
    ""
  ];
  logger.info(lines.join("\n"));
}
