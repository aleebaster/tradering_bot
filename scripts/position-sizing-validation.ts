import { ExchangeClient } from "../src/local/exchanges";
import { atr, ema } from "../src/local/indicators";
import { calculatePositionSizing } from "../src/local/positionSizing";
import { updateTelegramSettings } from "../src/local/telegramSettings";
import type { Candle, Side } from "../src/local/types";

const client = new ExchangeClient();
const symbols = ["BTCUSDT", "ETHUSDT", "AIGENSYNUSDT"];

async function main() {
  updateTelegramSettings({ balanceUsdt: 5, maxLeverage: "x5", riskMode: "Conservative", notifications: true });
  console.log(`POSITION SIZING VALIDATION ${new Date().toISOString()}`);
  console.log("Mode: simulated accepted trade using real Bybit Futures candles; balance=5 USDT.\n");
  validateBreakevenAndMarginRules();
  for (const symbol of symbols) {
    const candles = await client.bybitKlines(symbol, "15", "linear", 220);
    const setup = forcedSetup(symbol, candles);
    const sizing = calculatePositionSizing({ symbol, mode: "futures", side: setup.side, score: 92, entry: setup.entry, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, volatilityPct: setup.atr / setup.price, momentumScore: 82, marketRegime: "TRENDING" });
    console.log(`=== ${symbol} ===`);
    console.log(`Side: ${setup.side}`);
    console.log(`Real Bybit price: ${fmt(setup.price)}`);
    console.log(`📍 Entry: ${fmt(setup.entry[0])}-${fmt(setup.entry[1])}`);
    console.log(`⚡ Leverage: ${sizing?.leverage ?? "n/a"}`);
    console.log(`⚙️ Margin: ${sizing?.marginMode ?? "n/a"}`);
    console.log(`🛡 BE+: ${sizing?.breakevenPlusPrice ? fmt(sizing.breakevenPlusPrice) : "n/a"} offset=${sizing?.breakevenPlusOffsetPercent ?? "n/a"}% netBuffer=${sizing?.breakevenPlusNetBufferPercent ?? "n/a"}% mode=${sizing?.breakevenContinuationMode ?? "n/a"}`);
    console.log(`Activation: ${sizing?.breakevenActivationRule ?? "n/a"}`);
    console.log(`💰 Position size: ${sizing ? `${sizing.balanceUsdt} USDT -> ${sizing.positionSizeUsdt} USDT` : "n/a"}`);
    console.log(`🪙 Coin amount: ${sizing ? `${sizing.quantity} ${sizing.baseAsset}` : "n/a"}`);
    console.log(`🛑 Risk: SL=${fmt(setup.stopLoss)} maxLoss=${sizing?.potentialLossUsdt ?? "n/a"} USDT accountRisk=${sizing?.accountRiskPercent ?? "n/a"}%`);
    console.log(`🎯 TP: ${setup.takeProfit.map(fmt).join(" / ")}`);
    console.log(`RR: ${rr(setup.entry, setup.stopLoss, setup.takeProfit[2])}`);
    console.log(`${sizing ? "✅" : "❌"} Position sizing calculated\n`);
  }
}

function validateBreakevenAndMarginRules() {
  updateTelegramSettings({ balanceUsdt: 50, maxLeverage: "x5", riskMode: "Conservative", notifications: true });
  const longLarge = calculatePositionSizing({ symbol: "BTCUSDT", mode: "futures", side: "LONG", score: 96, entry: [100, 100], stopLoss: 98, takeProfit: [103, 105, 108], volatilityPct: 0.01, momentumScore: 86, volumeScore: 82, btcStable: true, orderFlowScore: 75, sniperConfidence: 88, marginMode: "ISOLATED" });
  updateTelegramSettings({ balanceUsdt: 5, maxLeverage: "x5", riskMode: "Conservative", notifications: true });
  const long = calculatePositionSizing({ symbol: "BTCUSDT", mode: "futures", side: "LONG", score: 96, entry: [100, 100], stopLoss: 98, takeProfit: [103, 105, 108], volatilityPct: 0.01, momentumScore: 86, volumeScore: 82, btcStable: true, orderFlowScore: 75, sniperConfidence: 88, marginMode: "ISOLATED" });
  const short = calculatePositionSizing({ symbol: "BTCUSDT", mode: "futures", side: "SHORT", score: 96, entry: [100, 100], stopLoss: 102, takeProfit: [97, 95, 92], volatilityPct: 0.02, momentumScore: 60, volumeScore: 55, btcStable: false, orderFlowScore: 50, sniperConfidence: 65, marginMode: "ISOLATED" });
  const cross = calculatePositionSizing({ symbol: "ETHUSDT", mode: "futures", side: "LONG", score: 96, entry: [100, 100], stopLoss: 98, takeProfit: [103, 105, 108], volatilityPct: 0.01, momentumScore: 86, volumeScore: 82, btcStable: true, orderFlowScore: 75, sniperConfidence: 88, marginMode: "CROSS" });
  const tinyWeak = calculatePositionSizing({ symbol: "ETHUSDT", mode: "futures", side: "LONG", score: 92, entry: [100, 100], stopLoss: 98, takeProfit: [103, 105, 108], volatilityPct: 0.01, momentumScore: 80, volumeScore: 80, btcStable: true, orderFlowScore: 75, sniperConfidence: 80, marginMode: "ISOLATED" });
  const highVol = calculatePositionSizing({ symbol: "ETHUSDT", mode: "futures", side: "LONG", score: 96, entry: [100, 100], stopLoss: 98, takeProfit: [103, 105, 108], volatilityPct: 0.02, momentumScore: 86, volumeScore: 82, btcStable: true, orderFlowScore: 75, sniperConfidence: 88, marginMode: "ISOLATED" });
  if (!longLarge || !long || !short || !cross || !tinyWeak || !highVol) throw new Error("BE+/margin validation setup failed");
  assert(long.breakevenPlusPrice! > long.averageEntry, "LONG TP1 -> BE+ must move SL above entry");
  assert(short.breakevenPlusPrice! < short.averageEntry, "SHORT TP1 -> BE+ must move SL below entry");
  assert((long.breakevenPlusNetBufferPercent ?? 0) >= 0.15, "BE+ net buffer must be at least 0.15%");
  assert((short.breakevenPlusNetBufferPercent ?? 0) <= 0.35, "BE+ net buffer must not exceed 0.35%");
  assert((long.breakevenPlusOffsetPercent ?? 0) > (long.breakevenPlusNetBufferPercent ?? 0), "BE+ offset must include Bybit fees");
  assert(long.breakevenActivationRule?.includes("Do not move on first TP1 wick"), "BE+ must not activate on first TP1 wick");
  assert(highVol.breakevenDelay?.includes("wait one extra confirmation candle"), "High volatility must delay BE+ confirmation");
  assert(longLarge.breakevenContinuationMode === "delay", "Strong continuation must allow room before tightening outside small-account mode");
  assert(short.breakevenContinuationMode === "tighten", "Weak continuation must tighten faster after confirmation");
  assert(short.antiShakeoutRule?.includes("liquidity-sweep"), "BE+ must include anti-shakeout liquidity sweep rule");
  assert(cross.marginMode === "CROSS" && cross.protectiveStopRequired && cross.leverage === "x2", "Cross margin must force strict x2 protective SL behavior");
  assert(tinyWeak.leverage === "x2" && tinyWeak.breakevenContinuationMode === "tighten", "Tiny account must use x2 and prioritize protection after confirmation");
  console.log("✅ BE+/margin rules: LONG, SHORT, fees, TP1 confirmation, volatility delay, anti-shakeout, CROSS, ISOLATED, tiny account protections passed\n");
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function forcedSetup(symbol: string, candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const price = candles.at(-1)!.close;
  const e20 = ema(closes, 20).at(-1) ?? price;
  const e50 = ema(closes, 50).at(-1) ?? price;
  const side: Extract<Side, "LONG" | "SHORT"> = e20 >= e50 ? "LONG" : "SHORT";
  const a = Math.max(atr(candles), price * 0.001);
  const entry: [number, number] = side === "LONG" ? [price - a * 0.15, price + a * 0.08] : [price - a * 0.08, price + a * 0.15];
  const avg = (entry[0] + entry[1]) / 2;
  const stopLoss = side === "LONG" ? avg - a * 1.25 : avg + a * 1.25;
  const risk = Math.abs(avg - stopLoss);
  const takeProfit: [number, number, number] = side === "LONG" ? [avg + risk * 1.2, avg + risk * 2, avg + risk * 3] : [avg - risk * 1.2, avg - risk * 2, avg - risk * 3];
  return { symbol, side, price, atr: a, entry, stopLoss, takeProfit };
}

function rr(entry: [number, number], stopLoss: number, tp3: number) {
  const avg = (entry[0] + entry[1]) / 2;
  const risk = Math.abs(avg - stopLoss);
  const reward = Math.abs(tp3 - avg);
  return risk > 0 ? `1:${(reward / risk).toFixed(1)}` : "n/a";
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(5) : value.toFixed(8);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
