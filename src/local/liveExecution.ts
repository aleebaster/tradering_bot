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

    logger.info({ symbol: signal.symbol, pipelineStage: "PRE_ORDER_SEND", signalSide: signal.side, signalEntry: signal.entry, signalStopLoss: signal.stopLoss, signalTakeProfit: signal.takeProfit, orderSide: order.side, orderQty: order.quantity, leverage: order.leverage, marginMode: order.marginMode, stopLoss: order.stopLoss, takeProfit: order.takeProfit }, "LiveExecution: pre-order validation PASSED");

    const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
    if (signal.side === "LONG") {
      if (signal.stopLoss >= avgEntry) {
        logger.error({ symbol: signal.symbol, side: signal.side, stopLoss: signal.stopLoss, avgEntry }, "CRITICAL PRE-SEND CHECK FAILED: LONG SL is above entry! Aborting execution.");
        return { success: false, error: `LONG SL (${signal.stopLoss}) >= entry (${avgEntry})`, takeProfitOrderIds: [] };
      }
      if (signal.takeProfit[0] <= avgEntry) {
        logger.error({ symbol: signal.symbol, side: signal.side, tp1: signal.takeProfit[0], avgEntry }, "CRITICAL PRE-SEND CHECK FAILED: LONG TP1 is below entry! Aborting execution.");
        return { success: false, error: `LONG TP1 (${signal.takeProfit[0]}) <= entry (${avgEntry})`, takeProfitOrderIds: [] };
      }
    }
    if (signal.side === "SHORT") {
      if (signal.stopLoss <= avgEntry) {
        logger.error({ symbol: signal.symbol, side: signal.side, stopLoss: signal.stopLoss, avgEntry }, "CRITICAL PRE-SEND CHECK FAILED: SHORT SL is below entry! Aborting execution.");
        return { success: false, error: `SHORT SL (${signal.stopLoss}) <= entry (${avgEntry})`, takeProfitOrderIds: [] };
      }
      if (signal.takeProfit[0] >= avgEntry) {
        logger.error({ symbol: signal.symbol, side: signal.side, tp1: signal.takeProfit[0], avgEntry }, "CRITICAL PRE-SEND CHECK FAILED: SHORT TP1 is above entry! Aborting execution.");
        return { success: false, error: `SHORT TP1 (${signal.takeProfit[0]}) >= entry (${avgEntry})`, takeProfitOrderIds: [] };
      }
    }

    logger.info({ symbol: signal.symbol, side: order.side, quantity: order.quantity, leverage: order.leverage, marginMode: order.marginMode }, "ORDER SENT: submitting main order to Bybit");

    const mainResult = await this.submitOrder(order);
    if (!mainResult.retCode || mainResult.retCode !== 0) {
      logger.error({ symbol: signal.symbol, pipelineStage: "ORDER_FAILED", retCode: mainResult.retCode, retMsg: mainResult.retMsg, side: order.side, quantity: order.quantity }, "BYBIT RESPONSE: main order FAILED");
      return { success: false, error: `Order failed: ${mainResult.retMsg}`, takeProfitOrderIds: [] };
    }

    const orderId = mainResult.result?.orderId as string | undefined;
    logger.info({ symbol: signal.symbol, pipelineStage: "ORDER_SUBMITTED", orderId, retCode: mainResult.retCode, retMsg: mainResult.retMsg }, "BYBIT RESPONSE: main order ACCEPTED");

    await this.waitForPosition(signal.symbol, signal.side);

    const posStatus = await this.checkPosition(signal.symbol);
    logger.info({ symbol: signal.symbol, pipelineStage: "POSITION_VERIFIED", positionExists: posStatus.exists, positionSide: posStatus.side, entryPrice: posStatus.entryPrice, quantity: posStatus.quantity, leverage: posStatus.leverage, marginMode: posStatus.marginMode }, "VERIFY POSITION: position status before SL/TP");

    logger.info({ symbol: signal.symbol, pipelineStage: "SET_TRADING_STOP", stopLoss: signal.stopLoss, stopLossSide: signal.side === "LONG" ? "Sell" : "Buy", quantity: order.quantity }, "SET TRADING STOP: submitting stop loss order");
    const slResult = await this.setStopLoss(signal, order.quantity);
    logger.info({ symbol: signal.symbol, pipelineStage: "STOP_LOSS_RESULT", retCode: slResult.retCode, retMsg: slResult.retMsg, stopLossOrderId: slResult.result?.orderId, triggerPrice: signal.stopLoss }, "BYBIT RESPONSE: stop loss");

    logger.info({ symbol: signal.symbol, pipelineStage: "SET_TAKE_PROFITS", takeProfit: signal.takeProfit, side: signal.side }, "SET TAKE PROFIT: submitting take profit orders");
    const tpResults = await this.setTakeProfits(signal, order.quantity);

    const slSuccess = slResult.retCode === 0;
    const tpSuccess = tpResults.every(r => r.retCode === 0);

    if (!slSuccess) {
      logger.error({ symbol: signal.symbol, pipelineStage: "STOP_LOSS_FAILED", slResult, stopLoss: signal.stopLoss }, "BYBIT RESPONSE: stop loss order FAILED - CRITICAL: position has no SL protection!");
    }
    if (!tpSuccess) {
      const failedTps = tpResults.filter(r => r.retCode !== 0);
      logger.error({ symbol: signal.symbol, pipelineStage: "TAKE_PROFIT_PARTIAL_FAIL", failedCount: failedTps.length, tpResults }, "BYBIT RESPONSE: one or more take profit orders FAILED");
    }

    const finalPos = await this.checkPosition(signal.symbol);
    logger.info({ symbol: signal.symbol, pipelineStage: "FINAL_VERIFICATION", positionExists: finalPos.exists, positionSide: finalPos.side, entryPrice: finalPos.entryPrice, quantity: finalPos.quantity, slSet: slSuccess, tpsSet: tpSuccess, slTriggerPrice: signal.stopLoss, tp1TriggerPrice: signal.takeProfit[0], tp2TriggerPrice: signal.takeProfit[1], tp3TriggerPrice: signal.takeProfit[2] }, "VERIFY POSITION: final state after SL/TP setup");

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
    const triggerDirection = signal.side === "LONG" ? 2 : 1;
    const closeSide = signal.side === "LONG" ? "Sell" : "Buy";

    const body = {
      category: "linear",
      symbol: signal.symbol,
      side: closeSide,
      orderType: "Market",
      qty: String(quantity),
      triggerDirection,
      triggerPrice: String(signal.stopLoss),
      reduceOnly: true,
      closeOnTrigger: true,
      positionIdx
    };

    logger.info({ symbol: signal.symbol, pipelineStage: "SL_ORDER_BODY", side: closeSide, triggerDirection, triggerPrice: signal.stopLoss, qty: quantity, positionIdx, expectedBehavior: signal.side === "LONG" ? "triggers when price FALLS below triggerPrice" : "triggers when price RISES above triggerPrice" }, "SET TRADING STOP: order body constructed");
    const response = await this.privateRequest(endpoint, body);
    logger.info({ symbol: signal.symbol, pipelineStage: "SL_ORDER_RESPONSE", retCode: response.retCode, retMsg: response.retMsg, orderId: response.result?.orderId, triggerPrice: signal.stopLoss }, "BYBIT RESPONSE: stop loss order");
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
      if (tpQty <= 0) {
        logger.info({ symbol: signal.symbol, tpIndex: i + 1, tpPercentage: tpPercentages[i], tpQty }, "TP SKIPPED: zero quantity for this level");
        continue;
      }

      const positionIdx = signal.side === "LONG" ? 1 : 2;
      const endpoint = "/v5/order/create";
      const closeSide = signal.side === "LONG" ? "Sell" : "Buy";
      const triggerDirection = signal.side === "LONG" ? 1 : 2;

      const body = {
        category: "linear",
        symbol: signal.symbol,
        side: closeSide,
        orderType: "Market",
        qty: String(Math.max(0, Math.round(tpQty * 1_000_000) / 1_000_000)),
        triggerDirection,
        triggerPrice: String(signal.takeProfit[i]),
        reduceOnly: true,
        positionIdx
      };

      logger.info({ symbol: signal.symbol, pipelineStage: `TP${i + 1}_ORDER_BODY`, side: closeSide, triggerDirection, triggerPrice: signal.takeProfit[i], qty: tpQty, percentage: tpPercentages[i], positionIdx, expectedBehavior: signal.side === "LONG" ? `triggers when price RISES above ${signal.takeProfit[i]}` : `triggers when price FALLS below ${signal.takeProfit[i]}` }, `SET TAKE PROFIT ${i + 1}: order body constructed`);
      const response = await this.privateRequest(endpoint, body);
      logger.info({ symbol: signal.symbol, pipelineStage: `TP${i + 1}_ORDER_RESPONSE`, retCode: response.retCode, retMsg: response.retMsg, orderId: response.result?.orderId, triggerPrice: signal.takeProfit[i] }, `BYBIT RESPONSE: TP${i + 1}`);
      results.push(response);
    }

    return results;
  }

  private async waitForPosition(symbol: string, side: "LONG" | "SHORT", maxAttempts = 10, delayMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const pos = await this.checkPosition(symbol);
      if (pos.exists && pos.side === side && (pos.quantity ?? 0) > 0) {
        logger.info({ symbol, pipelineStage: "POSITION_OPENED", side, entryPrice: pos.entryPrice, quantity: pos.quantity, leverage: pos.leverage, marginMode: pos.marginMode, attempt: i + 1 }, "POSITION OPENED: confirmed on Bybit");
        return;
      }
      logger.debug({ symbol, attempt: i + 1, maxAttempts, positionExists: pos.exists, positionSide: pos.side, quantity: pos.quantity }, "Waiting for position to appear");
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    logger.warn({ symbol, side }, "POSITION NOT CONFIRMED: continuing with SL/TP setup anyway (risk: position may not exist)");
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

    logger.info({ symbol: order.symbol, pipelineStage: "SUBMIT_ORDER_BODY", side: order.side, orderType: order.orderType, quantity: order.quantity, price: order.price, leverage: order.leverage, positionIdx: order.positionIdx, body }, "ORDER SENT: Bybit API request body");
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
