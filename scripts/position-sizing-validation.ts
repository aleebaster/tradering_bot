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
  for (const symbol of symbols) {
    const candles = await client.bybitKlines(symbol, "15", "linear", 220);
    const setup = forcedSetup(symbol, candles);
    const sizing = calculatePositionSizing({ symbol, mode: "futures", side: setup.side, score: 92, entry: setup.entry, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, volatilityPct: setup.atr / setup.price, momentumScore: 82, marketRegime: "TRENDING" });
    console.log(`=== ${symbol} ===`);
    console.log(`Side: ${setup.side}`);
    console.log(`Real Bybit price: ${fmt(setup.price)}`);
    console.log(`📍 Entry: ${fmt(setup.entry[0])}-${fmt(setup.entry[1])}`);
    console.log(`⚡ Leverage: ${sizing?.leverage ?? "n/a"}`);
    console.log(`💰 Position size: ${sizing ? `${sizing.balanceUsdt} USDT -> ${sizing.positionSizeUsdt} USDT` : "n/a"}`);
    console.log(`🪙 Coin amount: ${sizing ? `${sizing.quantity} ${sizing.baseAsset}` : "n/a"}`);
    console.log(`🛑 Risk: SL=${fmt(setup.stopLoss)} maxLoss=${sizing?.potentialLossUsdt ?? "n/a"} USDT accountRisk=${sizing?.accountRiskPercent ?? "n/a"}%`);
    console.log(`🎯 TP: ${setup.takeProfit.map(fmt).join(" / ")}`);
    console.log(`RR: ${rr(setup.entry, setup.stopLoss, setup.takeProfit[2])}`);
    console.log(`${sizing ? "✅" : "❌"} Position sizing calculated\n`);
  }
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
