import { logger } from "./logger";
import type { Signal, PositionSizing } from "./types";

export interface FormattedOrder {
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  quantity: number;
  price?: number;
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: number;
  marginMode: "ISOLATED" | "CROSS";
  timeInForce: "GTC" | "IOC" | "FOK";
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  positionIdx: 0 | 1 | 2;
  validPrice: boolean;
  validQuantity: boolean;
  validationErrors: string[];
}

export function formatOrder(signal: Signal): FormattedOrder | null {
  const errors: string[] = [];

  if (signal.side !== "LONG" && signal.side !== "SHORT") {
    errors.push(`Invalid signal side: ${signal.side}`);
    logger.error({ symbol: signal.symbol, side: signal.side }, "Cannot format order for non-LONG/SHORT signal");
    return null;
  }

  const ps = signal.positionSizing;
  if (!ps) {
    errors.push("Missing position sizing data");
    logger.error({ symbol: signal.symbol }, "Cannot format order without position sizing");
    return null;
  }

  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  const side: "Buy" | "Sell" = signal.side === "LONG" ? "Buy" : "Sell";
  const leverage = Number(ps.leverage.replace("x", "")) || 2;
  const marginMode = (ps.marginMode ?? "ISOLATED") as "ISOLATED" | "CROSS";
  const quantity = roundQuantity(ps.quantity, signal.symbol);
  const sl = roundPrice(signal.stopLoss, signal.symbol);
  const tp1 = roundPrice(signal.takeProfit[0], signal.symbol);
  const tp2 = roundPrice(signal.takeProfit[1], signal.symbol);
  const tp3 = roundPrice(signal.takeProfit[2], signal.symbol);
  const positionIdx = signal.side === "LONG" ? 1 : 2;

  if (quantity <= 0) {
    errors.push(`Invalid quantity: ${quantity}`);
  }

  if (sl <= 0) {
    errors.push(`Invalid stop loss: ${sl}`);
  }

  if (tp1 <= 0 || tp2 <= 0 || tp3 <= 0) {
    errors.push(`Invalid take profit levels: ${tp1}, ${tp2}, ${tp3}`);
  }

  if (signal.side === "LONG") {
    if (sl >= avgEntry) errors.push(`LONG SL (${sl}) must be below entry (${avgEntry})`);
    if (tp1 <= avgEntry) errors.push(`LONG TP1 (${tp1}) must be above entry (${avgEntry})`);
    if (tp2 <= tp1) errors.push(`LONG TP2 (${tp2}) must be above TP1 (${tp1})`);
    if (tp3 <= tp2) errors.push(`LONG TP3 (${tp3}) must be above TP2 (${tp2})`);
  }

  if (signal.side === "SHORT") {
    if (sl <= avgEntry) errors.push(`SHORT SL (${sl}) must be above entry (${avgEntry})`);
    if (tp1 >= avgEntry) errors.push(`SHORT TP1 (${tp1}) must be below entry (${avgEntry})`);
    if (tp2 >= tp1) errors.push(`SHORT TP2 (${tp2}) must be below TP1 (${tp1})`);
    if (tp3 >= tp2) errors.push(`SHORT TP3 (${tp3}) must be below TP2 (${tp2})`);
  }

  if (leverage < 1 || leverage > 100) {
    errors.push(`Invalid leverage: ${leverage}`);
  }

  if (errors.length > 0) {
    logger.error({ symbol: signal.symbol, side: signal.side, errors }, "Order formatting failed validation");
  }

  const orderType = signal.entryStatus === "ENTER_NOW" ? "Market" : "Limit";

  return {
    symbol: signal.symbol,
    side,
    orderType,
    quantity,
    price: orderType === "Limit" ? roundPrice(avgEntry, signal.symbol) : undefined,
    stopLoss: sl,
    takeProfit: [tp1, tp2, tp3],
    leverage,
    marginMode,
    timeInForce: orderType === "Limit" ? "GTC" : "IOC",
    reduceOnly: false,
    closeOnTrigger: false,
    positionIdx: positionIdx as 0 | 1 | 2,
    validPrice: errors.length === 0,
    validQuantity: quantity > 0,
    validationErrors: errors
  };
}

export function formatStopLossOrder(signal: Signal, quantity: number): {
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market";
  quantity: number;
  stopLoss: number;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  positionIdx: 0 | 1 | 2;
} | null {
  if (signal.side !== "LONG" && signal.side !== "SHORT") return null;

  const sl = roundPrice(signal.stopLoss, signal.symbol);
  const qty = roundQuantity(quantity, signal.symbol);
  const positionIdx = signal.side === "LONG" ? 1 : 2;

  return {
    symbol: signal.symbol,
    side: signal.side === "LONG" ? "Sell" : "Buy",
    orderType: "Market",
    quantity: qty,
    stopLoss: sl,
    reduceOnly: false,
    closeOnTrigger: true,
    positionIdx: positionIdx as 0 | 1 | 2
  };
}

export function formatTakeProfitOrders(signal: Signal, quantities: [number, number, number]): Array<{
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market";
  quantity: number;
  price: number;
  reduceOnly: boolean;
  positionIdx: 0 | 1 | 2;
}> {
  if (signal.side !== "LONG" && signal.side !== "SHORT") return [];

  const positionIdx = signal.side === "LONG" ? 1 : 2;
  const side: "Buy" | "Sell" = signal.side === "LONG" ? "Sell" : "Buy";

  return signal.takeProfit.map((tp, index) => ({
    symbol: signal.symbol,
    side,
    orderType: "Market" as const,
    quantity: roundQuantity(quantities[index], signal.symbol),
    price: roundPrice(tp, signal.symbol),
    reduceOnly: true,
    positionIdx: positionIdx as 0 | 1 | 2
  }));
}

function roundPrice(price: number, symbol: string): number {
  if (price >= 1000) return Math.round(price * 100) / 100;
  if (price >= 100) return Math.round(price * 1000) / 1000;
  if (price >= 10) return Math.round(price * 10000) / 10000;
  if (price >= 1) return Math.round(price * 100000) / 100000;
  return Math.round(price * 10000000) / 10000000;
}

function roundQuantity(qty: number, symbol: string): number {
  if (symbol.includes("1000")) {
    if (qty >= 1000) return Math.floor(qty);
    if (qty >= 100) return Math.floor(qty * 10) / 10;
    return Math.floor(qty * 100) / 100;
  }
  if (qty >= 1000) return Math.floor(qty);
  if (qty >= 100) return Math.floor(qty * 10) / 10;
  if (qty >= 10) return Math.floor(qty * 100) / 100;
  if (qty >= 1) return Math.floor(qty * 1000) / 1000;
  return Math.floor(qty * 1_000_000) / 1_000_000;
}
