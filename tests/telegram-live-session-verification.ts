import { ExchangeClient } from "../src/local/exchanges";
import { LiqBot, MarketReportBot, PumpDetectorBot, WhaleTrackerBot } from "../src/local/bots";
import { btcStable, buildSignal, regimeFrom } from "../src/local/scoring";
import { isRealEntrySignal, TelegramNotifier } from "../src/local/telegram";
import type { Candle, MarketSnapshot, Signal } from "../src/local/types";

const client = new ExchangeClient();
const notifier = new TelegramNotifier();
const pumpDetector = new PumpDetectorBot();
const whaleTracker = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();

const coreSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT", "HYPEUSDT", "1000PEPEUSDT"];
const durationMinutes = Number(process.env.LIVE_VERIFY_MINUTES ?? 30);
const cycleMs = Number(process.env.LIVE_VERIFY_CYCLE_SECONDS ?? 300) * 1000;
const maxSymbols = Number(process.env.LIVE_VERIFY_SYMBOLS ?? 20);

type EntryProof = {
  symbol: string;
  direction: string;
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: string;
  confidence: number;
  reason: string;
};

type Row = {
  cycle: number;
  symbol: string;
  topMover: boolean;
  side: string;
  score: number;
  entryStatus: string;
  executable: boolean;
  telegramSent: boolean;
  blocker: string;
};

async function main() {
  const startedAt = Date.now();
  const endsAt = startedAt + durationMinutes * 60_000;
  const rows: Row[] = [];
  const entries: EntryProof[] = [];
  const failures: string[] = [];
  let cycle = 0;

  while (Date.now() < endsAt) {
    cycle += 1;
    const cycleStartedAt = Date.now();
    const movers: string[] = await topMovers(maxSymbols - coreSymbols.length).catch((error) => {
      failures.push(`top movers unavailable: ${message(error)}`);
      return [] as string[];
    });
    const symbols = [...new Set([...coreSymbols, ...movers])].slice(0, maxSymbols);
    const btcCandles = await loadCandles("BTCUSDT");
    const btcOk = btcStable(btcCandles);

    for (const symbol of symbols) {
      try {
        const candles = symbol === "BTCUSDT" ? btcCandles : await loadCandles(symbol);
        const signal = await buildLiveSignal(symbol, candles, symbol === "BTCUSDT" ? true : btcOk);
        const telegramReady = isRealEntrySignal(signal);
        const executable = !["NO_TRADE", "WATCHLIST"].includes(signal.side);
        let sent = false;
        if (telegramReady) {
          await notifier.signal(signal);
          sent = true;
          entries.push(entryProof(signal));
        }
        rows.push({ cycle, symbol, topMover: movers.includes(symbol), side: signal.side, score: signal.score, entryStatus: signal.entryStatus, executable, telegramSent: sent, blocker: sent ? "EXECUTABLE_ENTRY_SENT" : exactBlocker(signal) });
      } catch (error) {
        failures.push(`${symbol}: ${message(error)}`);
      }
      await sleep(200);
    }

    const remaining = endsAt - Date.now();
    const wait = Math.min(cycleMs - (Date.now() - cycleStartedAt), remaining);
    if (wait > 0) await sleep(wait);
  }

  const executableEntries = rows.filter((row) => row.executable && row.telegramSent).length;
  const missedExecutableEntries = rows.filter((row) => row.executable && !row.telegramSent).length;
  const spamMessagesSent = rows.filter((row) => row.telegramSent && (row.side === "WATCHLIST" || row.side === "NO_TRADE")).length;
  const output = {
    ok: failures.length === 0 && missedExecutableEntries === 0 && spamMessagesSent === 0,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMinutes,
    cycles: cycle,
    symbolsPerCycle: maxSymbols,
    telegramMessagesSent: rows.filter((row) => row.telegramSent).length,
    executableEntries,
    internalWatchlist: rows.filter((row) => row.side === "WATCHLIST").length,
    internalNoTrade: rows.filter((row) => row.side === "NO_TRADE").length,
    spamMessagesSent,
    missedExecutableEntries,
    silentFailures: failures,
    entries,
    rows
  };

  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exit(1);
}

async function topMovers(limit: number) {
  const tickers = await client.bybitLinearTickers();
  return tickers
    .filter((ticker) => ticker.symbol.endsWith("USDT") && ticker.turnover24h >= 10_000_000)
    .sort((a, b) => Math.abs(b.price24hPcnt) - Math.abs(a.price24hPcnt))
    .map((ticker) => ticker.symbol)
    .filter((symbol) => !coreSymbols.includes(symbol))
    .slice(0, limit);
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
    binanceCandles: {},
    orderBookImbalance: orderBook.imbalance,
    fundingRate,
    openInterestChange,
    liquidityScore,
    whaleScore: intelligence.whale.smartMoneyScore,
    btcStable: btcOk,
    regime,
    confirmations: { bybit: true, okx: false, kucoin: false, binance: false, alignedCount: 1, conflict: false, details: ["Bybit live session verification"] },
    intelligence
  };
  return buildSignal(snapshot);
}

async function loadCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "5", "15", "60", "240", "D"]) {
    out[tf] = await client.bybitKlines(symbol, tf, "linear", tf === "D" ? 120 : 160);
    await sleep(90);
  }
  return out;
}

function entryProof(signal: Signal): EntryProof {
  const leverage = signal.score >= 96 && signal.confidence >= 94 ? "x3" : "x2";
  return {
    symbol: signal.symbol,
    direction: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    leverage,
    confidence: signal.confidence,
    reason: `score ${signal.score}; sniper ${signal.scoreBreakdown.entrySniper}; volume ${signal.scoreBreakdown.volumeConfirmation}; momentum ${signal.scoreBreakdown.momentumQuality}; liquidity sweep ${signal.scoreBreakdown.liquiditySweep}; BTC stable ${signal.btcStable}; RR ${signal.riskReward}; fake breakout ${signal.fakeBreakout.risk ? "blocked" : "low"}`
  };
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

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(message(error));
  process.exit(1);
});
