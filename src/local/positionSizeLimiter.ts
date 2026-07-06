import { ExchangeClient } from "./exchanges";
import { config } from "./config";
import { logger } from "./logger";

export interface PositionLimitResult {
  qty: string;
  capped: boolean;
  details: {
    calculatedPosition: string;
    safeLimit: string;
    exchangeQtyStep: string;
    roundedPosition: string;
    finalPosition: string;
    reason: string;
  };
}

export async function applyPositionSizeLimit(
  client: ExchangeClient,
  symbol: string,
  rawQty: number,
  entryPrice: number
): Promise<PositionLimitResult> {
  const noCap = (qty: string): PositionLimitResult => ({
    qty,
    capped: false,
    details: {
      calculatedPosition: "0.00 USDT",
      safeLimit: `${config.maxPositionUsdt.toFixed(2)} USDT`,
      exchangeQtyStep: "0",
      roundedPosition: "0.00 USDT",
      finalPosition: "0.00 USDT",
      reason: ""
    }
  });

  if (rawQty <= 0 || entryPrice <= 0) return noCap("0");

  const positionValueUsdt = rawQty * entryPrice;

  if (!config.safeTestMode || positionValueUsdt <= config.maxPositionUsdt) {
    return noCap(String(rawQty));
  }

  const info = await client.bybitSymbolInfo(symbol).catch(() => ({ qtyStep: 0.01, minQty: 0.01 }));
  const qtyStep = info.qtyStep;
  if (qtyStep <= 0) return noCap(String(rawQty));

  const maxQty = config.maxPositionUsdt / entryPrice;
  const steps = Math.floor(maxQty / qtyStep);
  const cappedQty = steps * qtyStep;
  const finalValue = cappedQty * entryPrice;

  const details = {
    calculatedPosition: `${positionValueUsdt.toFixed(2)} USDT`,
    safeLimit: `${config.maxPositionUsdt.toFixed(2)} USDT`,
    exchangeQtyStep: String(qtyStep),
    roundedPosition: `${finalValue.toFixed(2)} USDT`,
    finalPosition: `${finalValue.toFixed(2)} USDT`,
    reason: "SAFE_TEST_MODE"
  };

  logger.info({
    symbol,
    ...details,
    rawQty,
    cappedQty,
    entryPrice
  }, "positionSizeLimiter: capped by safe test mode");

  return { qty: String(cappedQty), capped: true, details };
}
