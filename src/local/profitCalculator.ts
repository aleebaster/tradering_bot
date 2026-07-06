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

  const candles = await client.bybitKlines(signal.symbol, "5", "linear", 20).catch(() => []);
  const atr = candles.length > 14 ? calcATR(candles, 14) : 0;
  const slDistance = long ? (entryPrice - sl) : (sl - entryPrice);
  const slDistancePct = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
  const slDistanceAtr = atr > 0 ? slDistance / atr : 0;

  const { tpCanIncrease, tpIncreaseReason } = await checkTpCanIncrease(client, signal, orderBook, candles, long);

  const passed = {
    netProfit: netProfit >= config.minNetProfitUsdt,
    rrAfterFees: rrAfterFees >= config.minRrAfterFees,
    profitFeeRatio: profitFeeRatio >= config.minProfitFeeRatio,
    minSlDistance: slDistanceAtr >= config.minSlDistanceAtr
  };

  const failures: string[] = [];
  if (!passed.netProfit) failures.push(`net profit ${netProfit.toFixed(2)} USDT < min ${config.minNetProfitUsdt} USDT`);
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
    passed,
    rejectReason: failures.length ? failures.join("; ") : ""
  };
}

function rejectReport(reason: string): ProfitReport {
  return {
    entryPrice: 0,
    positionValueUsdt: 0,
    grossProfit: 0,
    grossLoss: 0,
    fees: { takerFeeRate: 0, makerFeeRate: 0, entryFee: 0, exitFee: 0, totalFees: 0 },
    slippageEstimate: 0,
    fundingEstimate: 0,
    netProfit: 0,
    netLoss: 0,
    rrRaw: 0,
    rrAfterFees: 0,
    profitFeeRatio: 0,
    slDistancePct: 0,
    slDistanceAtr: 0,
    tpCanIncrease: false,
    tpIncreaseReason: "",
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
  client: ExchangeClient,
  signal: Signal,
  orderBook: { spreadPct: number; depthUsdt: number; imbalance: number; spoofRisk: boolean },
  candles: { high: number; low: number; close: number }[],
  long: boolean
): Promise<{ tpCanIncrease: boolean; tpIncreaseReason: string }> {
  if (orderBook.depthUsdt < 50000) return { tpCanIncrease: false, tpIncreaseReason: "low order book depth" };
  if (candles.length < 5) return { tpCanIncrease: false, tpIncreaseReason: "insufficient candles" };
  return { tpCanIncrease: true, tpIncreaseReason: "sufficient liquidity and momentum" };
}

export function logProfitReport(report: ProfitReport): void {
  logger.info({
    entryPrice: report.entryPrice.toFixed(6),
    positionValue: `${report.positionValueUsdt.toFixed(2)} USDT`,
    grossProfit: `${report.grossProfit.toFixed(4)} USDT`,
    grossLoss: `${report.grossLoss.toFixed(4)} USDT`,
    fees: `${report.fees.totalFees.toFixed(4)} USDT`,
    slippage: `${report.slippageEstimate.toFixed(4)} USDT`,
    funding: `${report.fundingEstimate.toFixed(4)} USDT`,
    netProfit: `${report.netProfit.toFixed(4)} USDT`,
    netLoss: `${report.netLoss.toFixed(4)} USDT`,
    rrRaw: report.rrRaw.toFixed(2),
    rrAfterFees: report.rrAfterFees.toFixed(2),
    profitFeeRatio: `${report.profitFeeRatio.toFixed(1)}x`,
    slDistanceAtr: report.slDistanceAtr.toFixed(2),
    tpCanIncrease: report.tpCanIncrease,
    netProfitPass: report.passed.netProfit,
    rrPass: report.passed.rrAfterFees,
    ratioPass: report.passed.profitFeeRatio,
    slPass: report.passed.minSlDistance
  }, "PROFIT ANALYSIS");
}
