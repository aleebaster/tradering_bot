import { ExchangeClient } from "./exchanges";
import { buildSignal, validateSignal } from "./scoring";
import { analyzeMomentumExit } from "./engines/MomentumExitEngine";
import { recordProtectionOutcome, signalsPaused } from "./lossProtection";
import { recordSignal, state } from "./state";
import { config } from "./config";
import { logger } from "./logger";
import { applyPositionSizeLimit } from "./positionSizeLimiter";
import type { BybitPosition, MarketSnapshot, Signal } from "./types";

export interface TradeState {
  signal: Signal;
  position: BybitPosition;
  orderId: string;
  openedAt: number;
  breakevenActivated: boolean;
  trailingActivated: boolean;
  highestPrice: number;
  lowestPrice: number;
  trailingStopPrice: number;
  slRetries: number;
  tpRetries: number;
}

const RECOVERY_MAX_RETRIES = 3;
const RECOVERY_RETRY_DELAY_MS = 2000;

export class TradeManager {
  private client = new ExchangeClient();
  private active: TradeState | null = null;
  private scanningPaused = false;

  hasActiveTrade(): boolean {
    return this.active !== null;
  }

  getActiveTrade(): TradeState | null {
    return this.active;
  }

  isScanningPaused(): boolean {
    return this.scanningPaused;
  }

  async openTrade(signal: Signal, snapshot: MarketSnapshot): Promise<{ ok: boolean; reason?: string }> {
    if (this.active) return { ok: false, reason: "already in active trade" };
    if (signalsPaused()) return { ok: false, reason: "signals paused by loss protection" };
    if (signal.side === "NO_TRADE" || signal.side === "WATCHLIST") return { ok: false, reason: `signal side is ${signal.side}` };

    const validation = validateSignal(signal, snapshot);
    if (validation) {
      const fails: string[] = [];
      if (!validation.offHours.pass) fails.push(`OffHours: ${validation.offHours.reason}`);
      if (!validation.risk.pass) fails.push(`Risk: ${validation.risk.reason}`);
      if (!validation.validator.pass) fails.push(`Validator: ${validation.validator.reason}`);
      if (fails.length) return { ok: false, reason: fails.join("; ") };
    }

    const bybitSide = signal.side === "LONG" || signal.side === "BUY" ? "Buy" as const : "Sell" as const;
    const riskQty = validation?.risk?.adjustments?.quantity;
    const rawQty = Math.max(riskQty && riskQty > 0 ? riskQty : signal.positionSizing?.quantity ?? 0, 0);

    const limitResult = rawQty > 0 ? await applyPositionSizeLimit(this.client, signal.symbol, rawQty, signal.currentPrice) : { qty: "0", capped: false };
    const qty = limitResult.qty;

    logger.info({ symbol: signal.symbol, side: bybitSide, qty, entry: signal.entry, sl: signal.stopLoss, tp: signal.takeProfit[0] }, "openTrade: placing order");

    const orderResult = await this.client.bybitPlaceOrder(signal.symbol, bybitSide, qty).catch(() => null);
    if (!orderResult || orderResult.retCode !== 0) {
      return { ok: false, reason: `order failed: ${orderResult?.retMsg ?? "no response"}` };
    }

    const orderId = orderResult.result?.orderId;
    if (!orderId) return { ok: false, reason: "no orderId in response" };

    logger.info({ orderId }, "openTrade: order placed, waiting for fill");
    await new Promise((r) => setTimeout(r, 1500));

    const position = await this.client.bybitGetPosition(signal.symbol).catch(() => null);
    if (!position || !position.size || Number(position.size) <= 0) {
      return { ok: false, reason: "position not found after order fill" };
    }

    logger.info({ side: position.side, size: position.size, entry: position.avgPrice }, "openTrade: position confirmed");

    if (signal.stopLoss > 0 || signal.takeProfit[0] > 0) {
      const slOk = await this.setStopLossWithRetry(signal.symbol, bybitSide, signal.stopLoss, signal.takeProfit[0]);
      if (!slOk) {
        await this.closePosition(signal.symbol, bybitSide);
        return { ok: false, reason: "SL/TP failed after retries — position closed for safety" };
      }
    }

    logger.info({ symbol: signal.symbol, orderId, size: position.size, entry: position.avgPrice }, "openTrade: trade opened successfully");

    this.active = {
      signal,
      position,
      orderId,
      openedAt: Date.now(),
      breakevenActivated: false,
      trailingActivated: false,
      highestPrice: bybitSide === "Buy" ? Number(position.avgPrice) : Number(position.avgPrice),
      lowestPrice: bybitSide === "Sell" ? Number(position.avgPrice) : Number(position.avgPrice),
      trailingStopPrice: bybitSide === "Buy" ? signal.stopLoss : signal.stopLoss,
      slRetries: 0,
      tpRetries: 0
    };

    recordSignal(signal);
    return { ok: true };
  }

  private async setStopLossWithRetry(symbol: string, side: "Buy" | "Sell", stopLoss: number, takeProfit: number): Promise<boolean> {
    const slStr = stopLoss > 0 ? stopLoss.toFixed(6) : undefined;
    const tpStr = takeProfit > 0 ? takeProfit.toFixed(6) : undefined;

    for (let attempt = 1; attempt <= RECOVERY_MAX_RETRIES; attempt++) {
      const result = await this.client.bybitSetTradingStop(symbol, side, slStr, tpStr).catch(() => null);
      const successCode = result?.retCode === 0 || result?.retCode === 34040;
      if (result && successCode) {
        if (attempt === 1 && result.retCode === 0) {
          logger.info({ attempt, symbol }, "SL/TP set successfully on first attempt");
          return true;
        }
        await new Promise((r) => setTimeout(r, 1500));
        const pos = await this.client.bybitGetPosition(symbol).catch(() => null);
        if (pos) {
          const slVerified = !slStr || (pos.stopLoss && Number(pos.stopLoss) > 0);
          const tpVerified = !tpStr || (pos.takeProfit && Number(pos.takeProfit) > 0);
          if (slVerified && tpVerified) {
            logger.info({ attempt, symbol }, "SL/TP verified on position");
            return true;
          }
          logger.warn({ attempt, symbol, posSl: pos.stopLoss, posTp: pos.takeProfit }, "SL/TP set but not yet visible on position (API propagation delay)");
        }
        return true;
      }
      logger.warn({ attempt, symbol, retCode: result?.retCode, retMsg: result?.retMsg }, "SL/TP retry");
      if (attempt < RECOVERY_MAX_RETRIES) await new Promise((r) => setTimeout(r, RECOVERY_RETRY_DELAY_MS));
    }

    logger.error({ symbol }, "SL/TP failed after all retries — Recovery Engine initiating position close");
    return false;
  }

  private async closePosition(symbol: string, side: "Buy" | "Sell"): Promise<boolean> {
    const closeSide = side === "Buy" ? "Sell" as const : "Buy" as const;
    const pos = await this.client.bybitGetPosition(symbol).catch(() => null);
    if (!pos || !pos.size || Number(pos.size) <= 0) return true;

    const result = await this.client.bybitPlaceOrder(symbol, closeSide, pos.size).catch(() => null);
    if (result && result.retCode === 0) {
      logger.info({ symbol, size: pos.size }, "closePosition: market order sent");
      return true;
    }
    logger.error({ symbol, retMsg: result?.retMsg }, "closePosition: failed");
    return false;
  }

  async monitorTrade(): Promise<{ action: "MONITOR" | "CLOSE" | "BREAKEVEN" | "TRAIL" | "TP_HIT"; reason: string; closePrice?: number }> {
    if (!this.active) return { action: "CLOSE", reason: "no active trade" };

    const { signal, position, openedAt } = this.active;
    const long = signal.side === "LONG" || signal.side === "BUY";

    const candles = await this.client.bybitKlines(signal.symbol, "5", "linear", 30).catch(() => []);
    const currentPrice = candles.at(-1)?.close ?? Number(position.avgPrice);
    const entryPrice = Number(position.avgPrice);
    const pnlPct = long ? (currentPrice - entryPrice) / entryPrice * 100 : (entryPrice - currentPrice) / entryPrice * 100;
    const holdMinutes = (Date.now() - openedAt) / 60000;

    if (long) {
      this.active.highestPrice = Math.max(this.active.highestPrice, currentPrice);
    } else {
      this.active.lowestPrice = Math.min(this.active.lowestPrice, currentPrice);
    }

    if (long && currentPrice <= signal.stopLoss) {
      return { action: "CLOSE", reason: `SL hit at ${currentPrice.toFixed(6)}`, closePrice: currentPrice };
    }
    if (!long && currentPrice >= signal.stopLoss) {
      return { action: "CLOSE", reason: `SL hit at ${currentPrice.toFixed(6)}`, closePrice: currentPrice };
    }

    const tp1 = signal.takeProfit[0];
    const tp2 = signal.takeProfit[1];
    const tp3 = signal.takeProfit[2];

    if ((long && currentPrice >= tp3) || (!long && currentPrice <= tp3)) {
      recordProtectionOutcome("WIN");
      return { action: "CLOSE", reason: `TP3 hit at ${currentPrice.toFixed(6)}`, closePrice: currentPrice };
    }

    if ((long && currentPrice >= tp2) || (!long && currentPrice <= tp2)) {
      if (!this.active.trailingActivated) {
        this.active.trailingActivated = true;
        return { action: "TRAIL", reason: `TP2 hit, activating trailing stop`, closePrice: currentPrice };
      }
    }

    if ((long && currentPrice >= tp1) || (!long && currentPrice <= tp1)) {
      if (!this.active.breakevenActivated) {
        this.active.breakevenActivated = true;
        const breakevenPrice = long ? entryPrice * 1.001 : entryPrice * 0.999;
        await this.client.bybitSetTradingStop(signal.symbol, long ? "Buy" as const : "Sell" as const, String(breakevenPrice));
        logger.info({ symbol: signal.symbol, breakevenPrice: breakevenPrice.toFixed(6) }, "breakeven SL activated");
        return { action: "BREAKEVEN", reason: `TP1 hit, SL moved to breakeven`, closePrice: currentPrice };
      }

      if (this.active.trailingActivated) {
        const trailDist = this.trailDistance(pnlPct);
        const trailPrice = long ? currentPrice * (1 - trailDist / 100) : currentPrice * (1 + trailDist / 100);
        const betterTrail = long ? trailPrice > this.active.trailingStopPrice : trailPrice < this.active.trailingStopPrice;
        if (betterTrail) {
          this.active.trailingStopPrice = trailPrice;
          await this.client.bybitSetTradingStop(signal.symbol, long ? "Buy" as const : "Sell" as const, String(trailPrice));
          logger.info({ symbol: signal.symbol, trailPrice: trailPrice.toFixed(6), trailDist: trailDist.toFixed(2) }, "trailing stop updated");
        }
      }

      if (this.active.trailingActivated) {
        const hitTrail = long ? currentPrice <= this.active.trailingStopPrice : currentPrice >= this.active.trailingStopPrice;
        if (hitTrail) {
          recordProtectionOutcome("WIN");
          return { action: "CLOSE", reason: `trailing stop hit at ${currentPrice.toFixed(6)}`, closePrice: currentPrice };
        }
      }

      if (this.active.breakevenActivated && pnlPct > 0) {
        const oi = await this.client.openInterestChange(signal.symbol).catch(() => 0);
        const ob = await this.client.bybitOrderBookStats(signal.symbol).catch(() => ({ imbalance: 0, depthUsdt: 0, spreadPct: 0, spoofRisk: false }));
        const exitInput = {
          symbol: signal.symbol,
          entryPrice,
          currentPrice,
          direction: long ? 1 as const : -1 as const,
          positionPnl: pnlPct * entryPrice / 100 * Number(position.size),
          positionPnlPct: pnlPct,
          candles: { "5": candles, "15": [] },
          openInterestChange: oi,
          fundingRate: await this.client.fundingRate(signal.symbol).catch(() => 0),
          volume: candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3,
          avgVolume: candles.reduce((s, c) => s + c.volume, 0) / Math.max(candles.length, 1),
          orderBookImbalance: ob.imbalance,
          holdTimeMinutes: holdMinutes
        };
        const exitSignal = analyzeMomentumExit(exitInput);
        state.momentum.activeExits[signal.symbol] = { output: exitSignal, updatedAt: new Date().toISOString() };

        if (exitSignal.recommendation === "EXIT") {
          recordProtectionOutcome("WIN");
          return { action: "CLOSE", reason: `exit signal: ${exitSignal.reason} (exhaustion ${exitSignal.pumpExhaustion}%)`, closePrice: currentPrice };
        }
        if (exitSignal.recommendation === "TRAIL" && !this.active.trailingActivated) {
          this.active.trailingActivated = true;
          this.active.trailingStopPrice = exitSignal.dynamicStopPrice;
          await this.client.bybitSetTradingStop(signal.symbol, long ? "Buy" as const : "Sell" as const, String(exitSignal.dynamicStopPrice));
          return { action: "TRAIL", reason: `exit engine recommends trailing: ${exitSignal.reason}`, closePrice: currentPrice };
        }
      }

      return { action: "MONITOR", reason: "in profit, monitoring" };
    }

    return { action: "MONITOR", reason: "waiting for price to reach levels" };
  }

  private trailDistance(pnlPct: number): number {
    if (pnlPct > 5) return 0.5;
    if (pnlPct > 3) return 0.8;
    if (pnlPct > 1.5) return 1.2;
    return 2.0;
  }

  async closeTrade(reason: string): Promise<{ ok: boolean }> {
    if (!this.active) return { ok: true };

    const { signal, position } = this.active;
    const long = signal.side === "LONG" || signal.side === "BUY";
    const closeSide = long ? "Sell" as const : "Buy" as const;

    logger.info({ symbol: signal.symbol, reason, size: position.size }, "closeTrade: closing position");

    const pos = await this.client.bybitGetPosition(signal.symbol).catch(() => null);
    if (pos && pos.size && Number(pos.size) > 0) {
      const result = await this.client.bybitPlaceOrder(signal.symbol, closeSide, pos.size).catch(() => null);
      if (!result || result.retCode !== 0) {
        logger.error({ symbol: signal.symbol, retMsg: result?.retMsg }, "closeTrade: market close failed");
        return { ok: false };
      }
      logger.info({ symbol: signal.symbol, orderId: result.result?.orderId }, "closeTrade: close order sent");
      await new Promise((r) => setTimeout(r, 1500));
    }

    const finalPos = await this.client.bybitGetPosition(signal.symbol).catch(() => null);
    const stillOpen = finalPos && finalPos.size && Number(finalPos.size) > 0;
    if (stillOpen) {
      logger.warn({ symbol: signal.symbol }, "closeTrade: position still open after close attempt");
      return { ok: false };
    }

    logger.info({ symbol: signal.symbol, reason, pnl: position.unrealisedPnl }, "closeTrade: position closed");
    this.active = null;
    return { ok: true };
  }

  reset(): void {
    this.active = null;
  }
}
