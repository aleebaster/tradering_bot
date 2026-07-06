import { ExchangeClient } from "./exchanges";
import { logger } from "./logger";

export interface FeeBreakdown {
  takerFeeRate: number;
  makerFeeRate: number;
  entryFee: number;
  exitFee: number;
  totalFees: number;
}

export async function calculateFees(
  client: ExchangeClient,
  symbol: string,
  positionValueUsdt: number,
  exitAsTaker: boolean
): Promise<FeeBreakdown> {
  const rates = await client.bybitFeeRate(symbol).catch(() => ({ takerFeeRate: 0.0006, makerFeeRate: 0.0001 }));

  const entryFee = positionValueUsdt * rates.takerFeeRate;
  const exitFee = positionValueUsdt * (exitAsTaker ? rates.takerFeeRate : Math.max(0, rates.makerFeeRate));

  return {
    takerFeeRate: rates.takerFeeRate,
    makerFeeRate: rates.makerFeeRate,
    entryFee,
    exitFee,
    totalFees: entryFee + exitFee
  };
}
