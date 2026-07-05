import crypto from "node:crypto";
import { config } from "./config";
import { logger } from "./logger";
import type { Signal } from "./types";
import { formatOrder, formatStopLossOrder, formatTakeProfitOrders, type FormattedOrder } from "./orderFormatter";

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  stopLossOrderId?: string;
  takeProfitOrderIds: string[];
  error?: string;
  slResult?: { retCode: number; retMsg: string };
  tpResults?: Array<{ retCode: number; retMsg: string; index: number }>;
}

export interface PositionStatus {
  exists: boolean;
  side?: "LONG" | "SHORT";
  entryPrice?: number;
  quantity?: number;
  unrealizedPnl?: number;
  leverage?: number;
  marginMode?: string;
}

export class LiveExecution {
  private enabled: boolean;
  private baseUrl: string;

  constructor() {
    this.enabled = Boolean(config.BYBIT_API_KEY && config.BYBIT_API_SECRET);
    this.baseUrl = process.env.BYBIT_REST_URL ?? "https://api.bybit.com";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async executeSignal(signal: Signal): Promise<ExecutionResult> {
    if (!this.enabled) {
      logger.warn({ symbol: signal.symbol }, "Live execution disabled - no API credentials");
      return { success: false, error: "Live execution disabled", takeProfitOrderIds: [] };
    }

    if (signal.side !== "LONG" && signal.side !== "SHORT") {
      return { success: false, error: `Invalid signal side: ${signal.side}`, takeProfitOrderIds: [] };
    }

    const order = formatOrder(signal);
    if (!order) {
      return { success: false, error: "Order formatting failed", takeProfitOrderIds: [] };
    }

    if (order.validationErrors.length > 0) {
      logger.error({ symbol: signal.symbol, errors: order.validationErrors }, "Order validation failed");
      return { success: false, error: `Validation failed: ${order.validationErrors.join("; ")}`, takeProfitOrderIds: [] };
    }

    logger.info({ symbol: signal.symbol, side: order.side, quantity: order.quantity, leverage: order.leverage, marginMode: order.marginMode }, "Executing order");

    const mainResult = await this.submitOrder(order);
    if (!mainResult.retCode || mainResult.retCode !== 0) {
      logger.error({ symbol: signal.symbol, retCode: mainResult.retCode, retMsg: mainResult.retMsg }, "Main order failed");
      return { success: false, error: `Order failed: ${mainResult.retMsg}`, takeProfitOrderIds: [] };
    }

    const orderId = mainResult.result?.orderId as string | undefined;
    logger.info({ symbol: signal.symbol, orderId }, "Main order submitted successfully");

    await this.waitForPosition(signal.symbol, signal.side);

    const slResult = await this.setStopLoss(signal, order.quantity);
    const tpResults = await this.setTakeProfits(signal, order.quantity);

    const slSuccess = slResult.retCode === 0;
    const tpSuccess = tpResults.every(r => r.retCode === 0);

    if (!slSuccess) {
      logger.error({ symbol: signal.symbol, slResult }, "Stop loss order failed");
    }
    if (!tpSuccess) {
      logger.error({ symbol: signal.symbol, tpResults }, "One or more take profit orders failed");
    }

    return {
      success: true,
      orderId: orderId as string | undefined,
      stopLossOrderId: slResult.result?.orderId as string | undefined,
      takeProfitOrderIds: tpResults.filter(r => r.retCode === 0).map(r => (r.result?.orderId as string) ?? ""),
      slResult: { retCode: slResult.retCode, retMsg: slResult.retMsg },
      tpResults: tpResults.map((r, i) => ({ retCode: r.retCode, retMsg: r.retMsg, index: i }))
    };
  }

  async checkPosition(symbol: string): Promise<PositionStatus> {
    if (!this.enabled) return { exists: false };

    try {
      const endpoint = `/v5/position/list?category=linear&symbol=${symbol}`;
      const response = await this.privateRequest(endpoint);

      if (response.retCode !== 0) {
        logger.error({ symbol, retCode: response.retCode, retMsg: response.retMsg }, "Failed to check position");
        return { exists: false };
      }

      const positions = (response.result as { list?: Array<Record<string, unknown>> })?.list ?? [];
      const active = positions.find((p) =>
        p.symbol === symbol && Number(p.size) > 0
      );

      if (!active) return { exists: false };

      return {
        exists: true,
        side: Number(active.side) === 1 ? "LONG" : "SHORT",
        entryPrice: Number(active.avgPrice),
        quantity: Number(active.size),
        unrealizedPnl: Number(active.unrealisedPnl),
        leverage: Number(active.leverage),
        marginMode: active.tpslMode === "Full" ? "CROSS" : "ISOLATED"
      };
    } catch (err) {
      logger.error({ symbol, err }, "Error checking position");
      return { exists: false };
    }
  }

  async closePosition(symbol: string, side: "LONG" | "SHORT"): Promise<{ success: boolean; error?: string }> {
    if (!this.enabled) return { success: false, error: "Live execution disabled" };

    try {
      const posSide = side === "LONG" ? 1 : 2;
      const endpoint = "/v5/order/create";
      const body = {
        category: "linear",
        symbol,
        side: side === "LONG" ? "Sell" : "Buy",
        orderType: "Market",
        qty: "0",
        reduceOnly: true,
        positionIdx: posSide
      };

      const response = await this.privateRequest(endpoint, body);
      if (response.retCode !== 0) {
        return { success: false, error: response.retMsg };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async setStopLoss(signal: Signal, quantity: number): Promise<{ retCode: number; retMsg: string; result?: Record<string, unknown> }> {
    const endpoint = "/v5/order/create";
    const positionIdx = signal.side === "LONG" ? 1 : 2;

    const body = {
      category: "linear",
      symbol: signal.symbol,
      side: signal.side === "LONG" ? "Sell" : "Buy",
      orderType: "Market",
      qty: String(quantity),
      triggerDirection: signal.side === "LONG" ? 2 : 1,
      triggerPrice: String(signal.stopLoss),
      reduceOnly: true,
      closeOnTrigger: true,
      positionIdx
    };

    logger.info({ symbol: signal.symbol, stopLoss: signal.stopLoss, side: body.side, qty: quantity }, "Setting stop loss");
    const response = await this.privateRequest(endpoint, body);
    logger.info({ symbol: signal.symbol, retCode: response.retCode, retMsg: response.retMsg, orderId: response.result?.orderId }, "Stop loss result");
    return response;
  }

  private async setTakeProfits(signal: Signal, quantity: number): Promise<Array<{ retCode: number; retMsg: string; result?: Record<string, unknown> }>> {
    const results = [];
    const tpPercentages = [
      signal.positionSizing?.tp1ClosePercent ?? 50,
      signal.positionSizing?.tp2ClosePercent ?? 50,
      signal.positionSizing?.runnerPercent ?? 0
    ];

    for (let i = 0; i < signal.takeProfit.length; i++) {
      const tpQty = quantity * (tpPercentages[i] / 100);
      if (tpQty <= 0) continue;

      const positionIdx = signal.side === "LONG" ? 1 : 2;
      const endpoint = "/v5/order/create";

      const body = {
        category: "linear",
        symbol: signal.symbol,
        side: signal.side === "LONG" ? "Sell" : "Buy",
        orderType: "Market",
        qty: String(Math.max(0, Math.round(tpQty * 1_000_000) / 1_000_000)),
        triggerDirection: signal.side === "LONG" ? 1 : 2,
        triggerPrice: String(signal.takeProfit[i]),
        reduceOnly: true,
        positionIdx
      };

      logger.info({ symbol: signal.symbol, tpIndex: i + 1, takeProfit: signal.takeProfit[i], qty: tpQty }, `Setting TP${i + 1}`);
      const response = await this.privateRequest(endpoint, body);
      logger.info({ symbol: signal.symbol, tpIndex: i + 1, retCode: response.retCode, retMsg: response.retMsg }, `TP${i + 1} result`);
      results.push(response);
    }

    return results;
  }

  private async waitForPosition(symbol: string, side: "LONG" | "SHORT", maxAttempts = 10, delayMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const pos = await this.checkPosition(symbol);
      if (pos.exists && pos.side === side && (pos.quantity ?? 0) > 0) {
        logger.info({ symbol, side, entryPrice: pos.entryPrice, quantity: pos.quantity }, "Position confirmed");
        return;
      }
      logger.debug({ symbol, attempt: i + 1, maxAttempts }, "Waiting for position to appear");
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    logger.warn({ symbol, side }, "Position not confirmed within timeout - continuing with SL/TP setup");
  }

  private async submitOrder(order: FormattedOrder): Promise<{ retCode: number; retMsg: string; result?: Record<string, unknown> }> {
    const endpoint = "/v5/order/create";
    const body: Record<string, unknown> = {
      category: "linear",
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      qty: String(order.quantity),
      timeInForce: order.timeInForce,
      reduceOnly: order.reduceOnly,
      closeOnTrigger: order.closeOnTrigger,
      positionIdx: order.positionIdx
    };

    if (order.orderType === "Limit" && order.price) {
      body.price = String(order.price);
      body.timeInForce = "GTC";
    }

    logger.info({ symbol: order.symbol, side: order.side, type: order.orderType, qty: order.quantity, price: order.price, leverage: order.leverage }, "Submitting main order");
    return this.privateRequest(endpoint, body);
  }

  private async privateRequest(endpoint: string, body?: Record<string, unknown>): Promise<{ retCode: number; retMsg: string; result?: Record<string, unknown> }> {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const bodyStr = body ? JSON.stringify(body) : "";
    const signPayload = `${timestamp}${endpoint.includes("?") ? endpoint.split("?")[1] + "&" : "?"}recv_window=${recvWindow}${bodyStr}`;
    const signature = crypto.createHmac("sha256", config.BYBIT_API_SECRET ?? "").update(signPayload).digest("hex");

    const url = `${this.baseUrl}${endpoint}${endpoint.includes("?") ? "&" : "?"}recv_window=${recvWindow}`;
    const headers: Record<string, string> = {
      "X-BAPI-API-KEY": config.BYBIT_API_KEY ?? "",
      "X-BAPI-SIGN": signature,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "Content-Type": "application/json"
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr || undefined,
      signal: AbortSignal.timeout(10_000)
    });

    const json = await res.json() as { retCode: number; retMsg: string; result?: Record<string, unknown> };

    if (json.retCode !== 0) {
      logger.error({ endpoint, retCode: json.retCode, retMsg: json.retMsg }, "Bybit API error");
    }

    return json;
  }
}
