import { ExchangeClient } from "../src/local/exchanges";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import { isRealEntrySignal } from "../src/local/telegram";
import type { Candle, MarketSnapshot, Signal } from "../src/local/types";

const client = new ExchangeClient();
const pumpDetector = new PumpDetectorBot();
const whaleTracker = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();

const requestedSymbols = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
  "SUIUSDT", "HYPEUSDT", "1000PEPEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "TONUSDT", "BNBUSDT", "LTCUSDT", "BCHUSDT",
  "DOTUSDT", "OPUSDT", "ARBUSDT", "NEARUSDT", "APTUSDT"
];

type Row = {
  symbol: string;
  side: string;
  score: number;
  entryStatus: string;
  executable: boolean;
  telegramSent: boolean;
  blocker: string;
};

async function main() {
  const symbols = requestedSymbols.slice(0, 20);

  const btcCandles = await loadCandles("BTCUSDT");
  const btcOk = btcStable(btcCandles);
  const rows: Row[] = [];

  for (const symbol of symbols) {
    const candles = symbol === "BTCUSDT" ? btcCandles : await loadCandles(symbol);
    const signal = await buildLiveSignal(symbol, candles, symbol === "BTCUSDT" ? true : btcOk);
    const executable = !["NO_TRADE", "WATCHLIST"].includes(signal.side);
    const telegramSent = executable && isRealEntrySignal(signal);
    rows.push({
      symbol,
      side: signal.side,
      score: signal.score,
      entryStatus: signal.entryStatus,
      executable,
      telegramSent,
      blocker: telegramSent ? "EXECUTABLE_ENTRY_SENT" : exactBlocker(signal)
    });
    await sleep(250);
  }

  const output = {
    ok: true,
    scannedAt: new Date().toISOString(),
    symbolsScanned: rows.length,
    telegramMessagesSent: rows.filter((row) => row.telegramSent).length,
    executableEntries: rows.filter((row) => row.executable && row.telegramSent).length,
    internalWatchlist: rows.filter((row) => row.side === "WATCHLIST").length,
    internalNoTrade: rows.filter((row) => row.side === "NO_TRADE").length,
    spamMessagesSent: rows.filter((row) => row.telegramSent && (row.side === "WATCHLIST" || row.side === "NO_TRADE")).length,
    ruleVerified: rows.every((row) => row.telegramSent === (row.executable && row.entryStatus === "ENTER_NOW" && row.blocker === "EXECUTABLE_ENTRY_SENT")),
    rows
  };

  console.log(JSON.stringify(output, null, 2));
  if (output.telegramMessagesSent !== output.executableEntries || output.spamMessagesSent !== 0 || !output.ruleVerified) process.exit(1);
}

async function buildLiveSignal(symbol: string, candles: Record<string, Candle[]>, btcOk: boolean): Promise<Signal> {
  const [orderBook, fundingRate, openInterestChange] = await Promise.all([
    client.bybitOrderBookStats(symbol).catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
    client.fundingRate(symbol).catch(() => 0),
    client.openInterestChange(symbol).catch(() => 0)
  ]);
  const liquidityScore = liquidity(candles["15"]);
  const regime = regimeFrom(candles);
  const intelligenceInput = { symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: btcOk, regime };
  const intelligence = {
    pump: pumpDetector.analyze(intelligenceInput),
    whale: whaleTracker.analyze(intelligenceInput),
    liq: liqBot.analyze(intelligenceInput),
    market: marketReportBot.analyze(intelligenceInput),
    updatedAt: new Date().toISOString()
  };

  const snapshot: MarketSnapshot = {
    symbol,
    mode: "futures",
    candles,
    okxCandles: {},
    kucoinCandles: {},
    krakenCandles: {},
    binanceCandles: {},
    orderBookImbalance: orderBook.imbalance,
    fundingRate,
    openInterestChange,
    liquidityScore,
    whaleScore: intelligence.whale.smartMoneyScore,
    btcStable: btcOk,
    regime,
    confirmations: { bybit: true, okx: false, kucoin: false, kraken: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit live silent proof"] },
    intelligence
  };
  return buildSignal(snapshot);
}

async function loadCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "5", "15", "60", "240", "D"]) {
    out[tf] = await client.bybitKlines(symbol, tf, "linear", tf === "D" ? 120 : 180);
    await sleep(100);
  }
  return out;
}

function exactBlocker(signal: Signal) {
  if (signal.side === "WATCHLIST") return "Internal watchlist only; Telegram silent";
  if (signal.side === "NO_TRADE") return signal.rejectionReason || "Internal no-trade; Telegram silent";
  if (signal.entryStatus !== "ENTER_NOW") return "Entry status not executable";
  if ((signal.scoreBreakdown.entrySniper ?? 0) < 70) return "No sniper trigger";
  if (!signal.btcStable && signal.symbol !== "BTCUSDT") return "BTC not stable";
  if ((signal.scoreBreakdown.volumeConfirmation ?? 0) < 65) return "Volume does not support move";
  if ((signal.scoreBreakdown.liquiditySweep ?? 0) < 65) return "No liquidity sweep/reclaim or retest";
  if (signal.fakeBreakout.risk) return "Fake-breakout risk";
  if (rrNumber(signal.riskReward) < 2) return "RR below 1:2";
  return "Executable side failed Telegram real-entry gate";
}

function liquidity(candles: Candle[]) {
  const dollarVolume = candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.close, 0) / 24;
  return Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
}

function rrNumber(value: string) {
  return Number(value.match(/:\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
