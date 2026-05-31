import { ExchangeClient } from "../src/local/exchanges";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import { TelegramNotifier } from "../src/local/telegram";
import { config } from "../src/local/config";
import type { Candle, ExchangeConfirmations, MarketSnapshot, Signal } from "../src/local/types";

const client = new ExchangeClient();
const notifier = new TelegramNotifier();
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const tfs = ["5", "15", "60"];
const bybitOnly = process.env.BYBIT_ONLY === "1";

async function main() {
  let btcCandles: Record<string, Candle[]>;
  try {
    btcCandles = await loadBybit("BTCUSDT");
  } catch {
    const message = conciseNoTrade("BTCUSDT");
    await notifier.send(message);
    console.log(message);
    return;
  }
  const btcOk = btcStable(btcCandles);
  const signals: Signal[] = [];
  for (const symbol of symbols) {
    let candles: Record<string, Candle[]>;
    try {
      candles = symbol === "BTCUSDT" ? btcCandles : await loadBybit(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Bybit ${symbol} failed; continuing safely: ${message}`);
      continue;
    }
    const [okx, kucoin, kraken, binance, imbalance, funding, oi] = await Promise.all([
      bybitOnly ? Promise.resolve(emptyCandles()) : loadOkx(symbol),
      bybitOnly ? Promise.resolve(emptyCandles()) : loadKucoin(symbol),
      bybitOnly ? Promise.resolve(emptyCandles()) : loadKraken(symbol),
      bybitOnly ? Promise.resolve(emptyCandles()) : loadBinance(symbol),
      client.orderBookImbalance(symbol).catch(() => 0),
      client.fundingRate(symbol).catch(() => 0),
      client.openInterestChange(symbol).catch(() => 0)
    ]);
    const snapshot: MarketSnapshot = {
      symbol,
      mode: "futures",
      candles,
      okxCandles: okx,
      kucoinCandles: kucoin,
      krakenCandles: kraken,
      binanceCandles: binance,
      orderBookImbalance: imbalance,
      fundingRate: funding,
      openInterestChange: oi,
      liquidityScore: liquidity(candles["15"]),
      whaleScore: Math.min(100, Math.max(0, Math.abs(oi) * 2500 + Math.abs(imbalance) * 120)),
      btcStable: symbol === "BTCUSDT" ? true : btcOk,
      regime: regimeFrom(candles),
      confirmations: confirmations(candles, okx, kucoin, kraken, binance)
    };
    signals.push(buildSignal(snapshot));
  }
  if (!signals.length) {
    const message = conciseNoTrade("BTCUSDT");
    await notifier.send(message);
    console.log(message);
    return;
  }
  const accepted = signals.filter((s) => s.side !== "NO_TRADE").sort((a, b) => b.score - a.score);
  const message = accepted[0] ? formatSignal(accepted[0]) : formatNoTrade(signals);
  await notifier.send(message);
  console.log(message);
}

async function loadBybit(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of tfs) {
    const candles = await client.bybitKlines(symbol, tf, "linear", 80);
    if (!Array.isArray(candles) || !candles.length) throw new Error(`Bybit futures candles empty ${symbol} ${tf}`);
    out[tf] = candles;
  }
  return out;
}

function emptyCandles() {
  return Object.fromEntries(tfs.map((tf) => [tf, [] as Candle[]]));
}

async function loadOkx(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.okxKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadKucoin(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.kucoinKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadKraken(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.krakenSpotKlines(symbol, tf).catch(() => [])] as const)));
}

async function loadBinance(symbol: string) {
  return Object.fromEntries(await Promise.all(tfs.map(async (tf) => [tf, await client.binanceKlines(symbol, tf).catch(() => [])] as const)));
}

function liquidity(candles: Candle[]) {
  if (!Array.isArray(candles) || !candles.length) return 0;
  const dollarVolume = candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function confirmations(bybit: Record<string, Candle[]>, okx: Record<string, Candle[]>, kucoin: Record<string, Candle[]>, kraken: Record<string, Candle[]>, binance: Record<string, Candle[]>): ExchangeConfirmations {
  const bybitDir = direction(bybit["15"]);
  const okxDir = direction(okx["15"]);
  const kucoinDir = direction(kucoin["15"]);
  const krakenDir = direction(kraken["15"]);
  const binanceDir = direction(binance["15"]);
  const okxAligned = okxDir !== 0 && okxDir === bybitDir;
  const kucoinAligned = kucoinDir !== 0 && kucoinDir === bybitDir;
  const krakenAligned = krakenDir !== 0 && krakenDir === bybitDir;
  const binanceAligned = binanceDir !== 0 && binanceDir === bybitDir;
  const conflict = [okxDir, kucoinDir, krakenDir].some((dir) => dir !== 0 && bybitDir !== 0 && dir !== bybitDir);
  return { bybit: bybitDir !== 0, okx: okxAligned, kucoin: kucoinAligned, kraken: krakenAligned, binance: binanceAligned, alignedCount: [bybitDir !== 0, okxAligned, kucoinAligned, krakenAligned, binanceAligned].filter(Boolean).length, conflict, details: [] };
}

function direction(candles?: Candle[]) {
  if (!candles || candles.length < 30) return 0;
  const last = candles.at(-1)!;
  const previous = candles.at(-20)!;
  if (last.close > previous.close) return 1;
  if (last.close < previous.close) return -1;
  return 0;
}

function formatSignal(signal: Signal) {
  const direction = signal.side === "SHORT" ? "SHORT" : "LONG";
  const icon = direction === "SHORT" ? "🔴" : "🟢";
  const sizing = signal.positionSizing;
  return [
    `${icon} ${direction} — ${signal.symbol}`,
    "",
    signal.entryStatus === "ENTER_NOW" ? "✅ ЗАХОДИТИ ЗАРАЗ" : "⏳ ЧЕКАТИ ЗОНУ ВХОДУ",
    "",
    "📍 Вхід:",
    `${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`,
    "",
    "🛑 Stop Loss:",
    fmt(signal.stopLoss),
    "",
    "🎯 TP1:",
    fmt(signal.takeProfit[0]),
    "",
    "🎯 TP2:",
    fmt(signal.takeProfit[1]),
    "",
    "🎯 TP3:",
    fmt(signal.takeProfit[2]),
    "",
    "⚡ Плече:",
    sizing?.leverage ?? signal.leverage ?? "x2",
    "",
    "💰 Баланс:",
    `${sizing?.balanceUsdt ?? config.USER_BALANCE_USDT} USDT`,
    "",
    "📦 Розмір позиції:",
    sizing ? `${sizing.positionSizeUsdt} USDT` : "тільки після підтвердження входу",
    "",
    `📌 Скільки ${direction === "SHORT" ? "шортити" : "купити"}:`,
    sizing ? `${formatQuantity(sizing.quantity)} ${sizing.baseAsset}` : "очікуємо підтвердження",
    "",
    "🟠 Беззбиток:",
    "Перенести Stop Loss після TP1"
  ].join("\n");
}

function formatNoTrade(signals: Signal[]) {
  return conciseNoTrade(signals[0]?.symbol ?? "BTCUSDT");
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value.toFixed(5);
}

function formatQuantity(value: number) {
  if (value >= 1000) return String(Math.floor(value));
  if (value >= 1) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function conciseNoTrade(symbol: string) {
  return [`❌ NO TRADE — ${symbol}`, "", "Причина:", "", "Слабкий сигнал.", "", "Чекаємо кращу точку входу."].join("\n");
}

main().catch((err) => {
  console.error("Помилка реального тесту сигналу", err instanceof Error ? err.message : err);
  process.exit(1);
});
