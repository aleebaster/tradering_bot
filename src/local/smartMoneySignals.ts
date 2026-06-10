import { getAltseasonIndex } from "./altseason";
import { getBtcForecast } from "./btcForecast";
import { ExchangeClient } from "./exchanges";
import { atr, clamp, ema, rsi, volumeProfileScore } from "./indicators";
import type { Candle } from "./types";

type Bias = "bullish" | "neutral" | "bearish";
type Side = "LONG" | "SHORT";
type SessionName = "Asia" | "London" | "New York";

type SessionLevel = {
  name: SessionName;
  high: number;
  low: number;
  highTime: string;
  lowTime: string;
};

type LiquiditySweep = {
  symbol: string;
  session: SessionName;
  side: Side;
  level: number;
  wick: number;
  valid: boolean;
  confirmed: boolean;
  reason: string;
};

type FvgSetup = {
  symbol: string;
  side: Side;
  low: number;
  high: number;
  midpoint: number;
  retested: boolean;
  confirmed: boolean;
  score: number;
  stage: string;
  reasons: string[];
};

type EntrySignal = {
  symbol: string;
  side: Side;
  confidence: number;
  grade: "ELITE" | "HIGH QUALITY" | "GOOD";
  reasons: string[];
  entry: [number, number];
  stopLoss: number;
  tp1: number;
  tp2: number;
  rr: number;
  setup: string;
};

export type SmartMoneyReport = {
  btcBias: {
    direction: Bias;
    confidence: number;
    sessionDirection: string;
    marketStructure: string;
    premiumDiscount: string;
    liquidityMap: string[];
    reasons: string[];
  };
  sessionLevels: SessionLevel[];
  sweeps: LiquiditySweep[];
  fvgSetups: FvgSetup[];
  entrySignals: EntrySignal[];
  altseason: {
    index: number;
    status: string;
    sectors: Array<{ name: string; icon: string; score: number; state: string }>;
  };
  dominanceImpact: string[];
  latencyMs: number;
  updatedAt: string;
};

const CACHE_MS = 45_000;
const client = new ExchangeClient();
let cache: { expiresAt: number; value: SmartMoneyReport } | null = null;
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT"];

export async function getSmartMoneyReport(): Promise<SmartMoneyReport> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const startedAt = Date.now();
  const [btc15, btc60, btc240, btcForecast, altseason] = await Promise.all([
    client.bybitKlines("BTCUSDT", "15", "linear", 220),
    client.bybitKlines("BTCUSDT", "60", "linear", 180),
    client.bybitKlines("BTCUSDT", "240", "linear", 140),
    getBtcForecast().catch(() => null),
    getAltseasonIndex().catch(() => null)
  ]);
  const sessionLevels = buildSessionLevels(btc15);
  const symbolData = await Promise.all(SYMBOLS.map(async (symbol) => ({
    symbol,
    m5: await client.bybitKlines(symbol, "5", "linear", 180).catch(() => []),
    m15: symbol === "BTCUSDT" ? btc15 : await client.bybitKlines(symbol, "15", "linear", 180).catch(() => [])
  })));
  const analyses = symbolData.map((data) => analyzeSymbol(data.symbol, data.m5, data.m15, sessionLevels)).filter(Boolean) as Array<{ sweeps: LiquiditySweep[]; fvg: FvgSetup[]; entry?: EntrySignal }>;
  const report: SmartMoneyReport = {
    btcBias: buildBtcBias(btc15, btc60, btc240, sessionLevels, btcForecast),
    sessionLevels,
    sweeps: analyses.flatMap((item) => item.sweeps).slice(0, 12),
    fvgSetups: analyses.flatMap((item) => item.fvg).filter((item) => item.score >= 70).sort((a, b) => b.score - a.score).slice(0, 10),
    entrySignals: analyses.map((item) => item.entry).filter((item): item is EntrySignal => Boolean(item)).filter((item) => item.confidence >= 80).sort((a, b) => b.confidence - a.confidence).slice(0, 6),
    altseason: buildSmartAltseason(altseason),
    dominanceImpact: buildDominanceImpact(btcForecast?.metrics.btcDominanceTrend, altseason?.index ?? 0),
    latencyMs: Date.now() - startedAt,
    updatedAt: new Date().toISOString()
  };
  cache = { expiresAt: Date.now() + CACHE_MS, value: report };
  return report;
}

export function formatSmartMoneyMenu(report: SmartMoneyReport) {
  return [
    "🧠 Smart Money Signals",
    "",
    `BTC Bias: ${biasIcon(report.btcBias.direction)} ${report.btcBias.direction.toUpperCase()} (${report.btcBias.confidence}%)`,
    `Entry Signals: ${report.entrySignals.length} high-quality`,
    `FVG Setups: ${report.fvgSetups.length} confirmed/watch`,
    `Sweeps: ${report.sweeps.filter((x) => x.valid).length} valid`,
    `Altseason: ${report.altseason.index}% ${report.altseason.status}`,
    "",
    "Strategy gate:",
    "Session liquidity → confluence → sweep → displacement/BOS → FVG → retest.",
    "",
    `Updated: ${shortTime(report.updatedAt)} | latency ${report.latencyMs}ms`
  ].join("\n");
}

export function formatSmartMoneyHome() {
  return [
    "🧠 Smart Money",
    "",
    "Institutional / Pro Signals меню.",
    "",
    "Entry logic:",
    "✅ session liquidity sweep",
    "✅ support/resistance confluence",
    "✅ displacement + BOS/CHOCH",
    "✅ FVG created",
    "✅ FVG retest + confirmation candle",
    "✅ confidence >80",
    "",
    "Без повного ланцюга: NO SIGNAL.",
    "",
    "Обери розділ нижче."
  ].join("\n");
}

export function formatSmartMoneyDashboard(report: SmartMoneyReport) {
  const liquidityTaken = report.sweeps.some((sweep) => sweep.valid);
  const fvgPresent = report.fvgSetups.length > 0;
  const fvgRetested = report.fvgSetups.some((setup) => setup.retested);
  const ready = report.entrySignals.length > 0;
  const waiting = !liquidityTaken ? "Waiting liquidity sweep" : !fvgPresent ? "Waiting FVG" : !fvgRetested ? "Waiting FVG retest" : ready ? "Confirmed" : "Waiting confirmation";
  const risk = report.btcBias.direction === "neutral" || report.altseason.index < 30 ? "Medium" : report.btcBias.confidence >= 72 && report.altseason.index >= 45 ? "Low" : "High";
  const confidence = ready ? Math.max(...report.entrySignals.map((signal) => signal.confidence)) : Math.round(report.btcBias.confidence * 0.55 + (liquidityTaken ? 12 : 0) + (fvgRetested ? 18 : fvgPresent ? 8 : 0));
  return [
    "📊 Smart Money Dashboard",
    "",
    `₿ BTC Bias: ${biasIcon(report.btcBias.direction)} ${report.btcBias.direction.toUpperCase()} (${report.btcBias.confidence}%)`,
    `🌍 Session liquidity: ${liquidityTaken ? "Taken" : "Untouched"}`,
    `💧 Sweep status: ${liquidityTaken ? "Taken" : "Untouched"}`,
    `⚡ FVG status: ${fvgPresent ? fvgRetested ? "Found / Retested" : "Found / Waiting retest" : "Not found"}`,
    `🎯 Current setup: ${ready ? "Ready" : waiting}`,
    `🏦 Altseason: ${report.altseason.index}%`,
    `🧠 Confidence: ${Math.min(99, confidence)}%`,
    `🛡 Market Risk: ${risk}`,
    "",
    `Latency: ${report.latencyMs}ms | Updated: ${shortTime(report.updatedAt)}`
  ].join("\n");
}

export function formatSmartBtcBias(report: SmartMoneyReport) {
  const bias = report.btcBias;
  return [
    "📈 BTC Bias",
    "",
    `Direction: ${biasIcon(bias.direction)} ${bias.direction.toUpperCase()} (${bias.confidence}%)`,
    `Session direction: ${bias.sessionDirection}`,
    `Market structure: ${bias.marketStructure}`,
    `Zone: ${bias.premiumDiscount}`,
    "",
    "Liquidity map:",
    ...bias.liquidityMap.map((item) => `• ${item}`),
    "",
    "Reasons:",
    ...bias.reasons.map((item) => `✅ ${item}`)
  ].join("\n");
}

export function formatLiquiditySweeps(report: SmartMoneyReport) {
  return [
    "💧 Liquidity Sweeps",
    "",
    ...(report.sweeps.length ? report.sweeps.map((sweep) => `${sweep.valid ? "✅" : "⚠️"} ${sweep.symbol} ${sweep.side} | ${sweep.session} ${sweep.side === "LONG" ? "low" : "high"} swept | level ${fmt(sweep.level)} | wick ${fmt(sweep.wick)} | ${sweep.confirmed ? "confirmed" : "waiting impulse"}`) : ["No valid session sweep right now."]),
    "",
    "Rule: no sweep = no trade."
  ].join("\n");
}

export function formatFvgSetups(report: SmartMoneyReport) {
  const body = report.fvgSetups.length ? report.fvgSetups.map((setup) => [`${setup.confirmed ? "✅" : "⏳"} ${setup.symbol} ${setup.side} ${setup.score}%`, `FVG: ${fmt(setup.low)}-${fmt(setup.high)} | mid ${fmt(setup.midpoint)}`, `Stage: ${setup.stage}`, `Reason: ${setup.reasons.slice(0, 4).join("; ")}`].join("\n")).join("\n\n") : "No confirmed FVG retest setup. Waiting for sweep → displacement → FVG → retest.";
  return ["⚡ FVG Setups", "", body].join("\n");
}

export function formatEntrySignals(report: SmartMoneyReport) {
  const hasSweep = report.sweeps.some((sweep) => sweep.valid);
  const hasFvgRetest = report.fvgSetups.some((setup) => setup.retested);
  return [
    "🎯 Entry Signals",
    "",
    ...(report.entrySignals.length ? report.entrySignals.map(formatEntrySignal) : [
      "❌ No high quality institutional setup",
      "",
      "Reason:",
      `${hasSweep ? "✅" : "❌"} liquidity sweep`,
      "❌ BOS / CHOCH confirmation",
      "❌ displacement candle",
      `${hasFvgRetest ? "✅" : "❌"} FVG retest`,
      "❌ confirmation candle",
      "❌ score < 80",
      "",
      "NO SIGNAL until full Smart Money chain is complete."
    ])
  ].join("\n");
}

export function formatSessionLevels(report: SmartMoneyReport) {
  return ["🌍 Session Levels", "", report.sessionLevels.map((session) => [`${sessionName(session.name)} Session`, `High: ${fmt(session.high)}`, `Low: ${fmt(session.low)}`].join("\n")).join("\n\n")].join("\n");
}

export function formatSmartAltseason(report: SmartMoneyReport) {
  return [
    "🏦 Altseason Index",
    "",
    `Altseason Index: ${report.altseason.index}%`,
    "",
    "Status:",
    report.altseason.status,
    "",
    "Sectors:",
    ...report.altseason.sectors.map((sector) => `${sector.icon} ${sector.name} ${sector.score}% ${sector.state}`)
  ].join("\n");
}

export function formatDominanceImpact(report: SmartMoneyReport) {
  return [
    "🪙 BTC Dominance Impact",
    "",
    ...report.dominanceImpact.map((item) => `• ${item}`),
    "",
    `Altseason probability: ${report.altseason.index}%`
  ].join("\n");
}

function analyzeSymbol(symbol: string, m5: Candle[], m15: Candle[], btcSessions: SessionLevel[]) {
  if (m5.length < 80 || m15.length < 80) return null;
  const levels = symbol === "BTCUSDT" ? btcSessions : buildSessionLevels(m15);
  const recent = m5.slice(-60);
  const sweep = detectSweep(symbol, recent, levels);
  const confluence = confluenceScore(recent, sweep);
  const displacement = displacementAfterSweep(recent, sweep);
  const fvg = detectFvg(symbol, recent, sweep?.side ?? "LONG", displacement.index);
  const retest = fvg ? fvgRetest(recent, fvg) : false;
  const confirmation = fvg ? confirmationCandle(recent, fvg.side) : false;
  const bos = breakOfStructure(recent, fvg?.side ?? sweep?.side ?? "LONG");
  const reasons = [
    sweep?.valid ? `${sweep.session} ${sweep.side === "LONG" ? "low" : "high"} swept` : null,
    confluence >= 20 ? `${sweep?.side === "LONG" ? "Support" : "Resistance"} confluence` : null,
    displacement.valid ? "Strong displacement" : null,
    fvg ? "FVG created" : null,
    retest ? "FVG retest confirmed" : null,
    bos ? "BOS confirmed" : null
  ].filter(Boolean) as string[];
  const score = Math.round(clamp((sweep?.valid ? 22 : 0) + confluence + (displacement.valid ? 18 : 0) + (fvg ? 16 : 0) + (retest ? 14 : 0) + (confirmation ? 8 : 0) + (bos ? 8 : 0)));
  const fvgSetup = fvg ? { ...fvg, retested: retest, confirmed: Boolean(sweep?.valid && confluence >= 20 && displacement.valid && retest && confirmation && bos), score, stage: stageName(Boolean(sweep?.valid), confluence >= 20, displacement.valid, true, retest, confirmation && bos), reasons } : undefined;
  const entry = fvgSetup?.confirmed && score >= 80 ? buildEntry(symbol, fvgSetup, recent, sweep, score, reasons) : undefined;
  return { sweeps: sweep ? [sweep] : [], fvg: fvgSetup ? [fvgSetup] : [], entry };
}

function buildSessionLevels(candles: Candle[]): SessionLevel[] {
  return (["Asia", "London", "New York"] as SessionName[]).map((name) => sessionLevel(name, candles)).filter((x): x is SessionLevel => Boolean(x));
}

function sessionLevel(name: SessionName, candles: Candle[]): SessionLevel | null {
  const hours = name === "Asia" ? [0, 8] : name === "London" ? [7, 16] : [13, 22];
  const rows = candles.slice(-220).filter((candle) => {
    const hour = new Date(candle.openTime).getUTCHours();
    return hour >= hours[0] && hour < hours[1];
  }).slice(-40);
  if (!rows.length) return null;
  const highCandle = rows.reduce((best, candle) => candle.high > best.high ? candle : best, rows[0]);
  const lowCandle = rows.reduce((best, candle) => candle.low < best.low ? candle : best, rows[0]);
  return { name, high: highCandle.high, low: lowCandle.low, highTime: new Date(highCandle.openTime).toISOString(), lowTime: new Date(lowCandle.openTime).toISOString() };
}

function detectSweep(symbol: string, candles: Candle[], levels: SessionLevel[]): LiquiditySweep | null {
  const last = candles.at(-1)!;
  const prev = candles.slice(-10, -1);
  const candidates = levels.flatMap((session) => {
    const sweptLow = prev.some((c) => c.low < session.low && c.close > session.low) || last.low < session.low && last.close > session.low;
    const sweptHigh = prev.some((c) => c.high > session.high && c.close < session.high) || last.high > session.high && last.close < session.high;
    return [
      sweptLow ? { symbol, session: session.name, side: "LONG" as const, level: session.low, wick: Math.min(...prev.map((c) => c.low), last.low), valid: true, confirmed: last.close > session.low, reason: "Stop hunt below session low" } : null,
      sweptHigh ? { symbol, session: session.name, side: "SHORT" as const, level: session.high, wick: Math.max(...prev.map((c) => c.high), last.high), valid: true, confirmed: last.close < session.high, reason: "Stop hunt above session high" } : null
    ];
  }).filter(Boolean) as LiquiditySweep[];
  return candidates.at(-1) ?? null;
}

function confluenceScore(candles: Candle[], sweep: LiquiditySweep | null) {
  if (!sweep) return 0;
  const recent = candles.slice(-80);
  const price = recent.at(-1)!.close;
  const rangeHigh = Math.max(...recent.map((c) => c.high));
  const rangeLow = Math.min(...recent.map((c) => c.low));
  const mid = (rangeHigh + rangeLow) / 2;
  const averageRange = atr(recent) || (rangeHigh - rangeLow) / 50;
  const nearLevel = Math.abs(price - sweep.level) <= averageRange * 2;
  const premiumDiscount = sweep.side === "LONG" ? price <= mid : price >= mid;
  const priorReaction = recent.slice(-40, -8).some((c) => sweep.side === "LONG" ? Math.abs(c.low - sweep.level) <= averageRange : Math.abs(c.high - sweep.level) <= averageRange);
  return (nearLevel ? 9 : 0) + (premiumDiscount ? 8 : 0) + (priorReaction ? 8 : 0);
}

function displacementAfterSweep(candles: Candle[], sweep: LiquiditySweep | null) {
  if (!sweep) return { valid: false, index: Math.max(0, candles.length - 10) };
  const avgBody = candles.slice(-40).reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 40;
  const start = Math.max(3, candles.length - 12);
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const directional = sweep.side === "LONG" ? c.close > c.open : c.close < c.open;
    if (directional && body >= avgBody * 1.55) return { valid: true, index: i };
  }
  return { valid: false, index: start };
}

function detectFvg(symbol: string, candles: Candle[], side: Side, fromIndex: number): FvgSetup | null {
  for (let i = Math.max(2, fromIndex); i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (side === "LONG" && c.low > a.high) return { symbol, side, low: a.high, high: c.low, midpoint: (a.high + c.low) / 2, retested: false, confirmed: false, score: 0, stage: "FVG created", reasons: [] };
    if (side === "SHORT" && c.high < a.low) return { symbol, side, low: c.high, high: a.low, midpoint: (c.high + a.low) / 2, retested: false, confirmed: false, score: 0, stage: "FVG created", reasons: [] };
  }
  return null;
}

function fvgRetest(candles: Candle[], fvg: FvgSetup) {
  return candles.slice(-10).some((c) => c.low <= fvg.high && c.high >= fvg.low && (fvg.side === "LONG" ? c.close >= fvg.midpoint : c.close <= fvg.midpoint));
}

function confirmationCandle(candles: Candle[], side: Side) {
  const last = candles.at(-1)!;
  const avgBody = candles.slice(-30).reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 30;
  const body = Math.abs(last.close - last.open);
  return side === "LONG" ? last.close > last.open && body >= avgBody * 1.1 : last.close < last.open && body >= avgBody * 1.1;
}

function breakOfStructure(candles: Candle[], side: Side) {
  const last = candles.at(-1)!;
  const prior = candles.slice(-35, -2);
  if (side === "LONG") return last.close > Math.max(...prior.map((c) => c.high));
  return last.close < Math.min(...prior.map((c) => c.low));
}

function buildEntry(symbol: string, fvg: FvgSetup, candles: Candle[], sweep: LiquiditySweep | null, score: number, reasons: string[]): EntrySignal {
  const riskPad = (atr(candles) || candles.at(-1)!.close * 0.003) * 0.35;
  const entry: [number, number] = [fvg.low, fvg.high];
  const stopLoss = fvg.side === "LONG" ? Math.min(sweep?.wick ?? fvg.low, fvg.low) - riskPad : Math.max(sweep?.wick ?? fvg.high, fvg.high) + riskPad;
  const entryMid = fvg.midpoint;
  const risk = Math.abs(entryMid - stopLoss);
  const tp1 = fvg.side === "LONG" ? entryMid + risk * 1.5 : entryMid - risk * 1.5;
  const tp2 = fvg.side === "LONG" ? entryMid + risk * 3 : entryMid - risk * 3;
  return { symbol, side: fvg.side, confidence: score, grade: score >= 90 ? "ELITE" : "HIGH QUALITY", reasons, entry, stopLoss, tp1, tp2, rr: 3, setup: "Liquidity Sweep + FVG Retest" };
}

function buildBtcBias(m15: Candle[], h1: Candle[], h4: Candle[], sessions: SessionLevel[], forecast: Awaited<ReturnType<typeof getBtcForecast>> | null): SmartMoneyReport["btcBias"] {
  const closes = h1.map((c) => c.close);
  const ema21 = ema(closes, 21).at(-1) ?? closes.at(-1) ?? 0;
  const ema50 = ema(closes, 50).at(-1) ?? ema21;
  const price = closes.at(-1) ?? 0;
  const structure = marketStructure(h4);
  const biasScore = clamp(50 + (price > ema21 ? 14 : -14) + (ema21 > ema50 ? 16 : -16) + structure * 18 + (rsi(closes) - 50) * 0.35);
  const direction: Bias = biasScore >= 58 ? "bullish" : biasScore <= 42 ? "bearish" : "neutral";
  const rangeHigh = Math.max(...m15.slice(-96).map((c) => c.high));
  const rangeLow = Math.min(...m15.slice(-96).map((c) => c.low));
  const mid = (rangeHigh + rangeLow) / 2;
  return {
    direction,
    confidence: Math.round(direction === "bearish" ? 100 - biasScore : biasScore),
    sessionDirection: forecast?.frames[0]?.direction ?? direction,
    marketStructure: structure > 0 ? "HH/HL bullish structure" : structure < 0 ? "LH/LL bearish structure" : "range / no clean BOS",
    premiumDiscount: price >= mid ? "premium zone" : "discount zone",
    liquidityMap: sessions.flatMap((session) => [`${session.name} high ${fmt(session.high)}`, `${session.name} low ${fmt(session.low)}`]).slice(0, 6),
    reasons: [price > ema21 ? "Price above EMA21" : "Price below EMA21", ema21 > ema50 ? "EMA21 above EMA50" : "EMA21 below EMA50", structure > 0 ? "BOS up / bullish structure" : structure < 0 ? "BOS down / bearish structure" : "No clean BOS"]
  };
}

function buildSmartAltseason(altseason: Awaited<ReturnType<typeof getAltseasonIndex>> | null): SmartMoneyReport["altseason"] {
  const index = altseason?.index ?? 0;
  return {
    index,
    status: index >= 80 ? "🟢 Strong Altseason" : index >= 60 ? "🟡 Early Rotation" : index >= 30 ? "🟡 Mixed Market" : "🔴 BTC Season",
    sectors: (altseason?.sectors ?? []).map((sector) => ({ name: sector.name, icon: sectorIcon(sector.name), score: sector.score, state: sector.score >= 62 ? "strong" : sector.score >= 45 ? "mixed" : "weak" }))
  };
}

function buildDominanceImpact(trend: "rising" | "flat" | "falling" | undefined, altIndex: number) {
  if (trend === "rising") return ["BTC dominance growing → alt pressure.", "Prefer BTC/ETH or only strongest institutional alt setups.", `Altseason probability is capped while dominance rises (${altIndex}%).`];
  if (trend === "falling") return ["BTC dominance falling → rotation into alts possible.", "BTC weak + dominance falling → altseason probability rising.", "Still require sweep + FVG retest before entries."];
  return ["BTC dominance flat → mixed market.", "Trade only clean liquidity sweeps with confirmed FVG retests."];
}

function marketStructure(candles: Candle[]) {
  const recent = candles.slice(-40);
  const first = recent.slice(0, 20);
  const last = recent.slice(20);
  if (!first.length || !last.length) return 0;
  const firstHigh = Math.max(...first.map((c) => c.high));
  const firstLow = Math.min(...first.map((c) => c.low));
  const lastHigh = Math.max(...last.map((c) => c.high));
  const lastLow = Math.min(...last.map((c) => c.low));
  if (lastHigh > firstHigh && lastLow > firstLow) return 1;
  if (lastHigh < firstHigh && lastLow < firstLow) return -1;
  return 0;
}

function stageName(sweep: boolean, confluence: boolean, displacement: boolean, fvg: boolean, retest: boolean, entry: boolean) {
  if (entry) return "Stage 6: retest entry confirmed";
  if (retest) return "Stage 6: retest waiting confirmation";
  if (fvg) return "Stage 5: FVG created, waiting retest";
  if (displacement) return "Stage 4: displacement confirmed";
  if (confluence) return "Stage 2: confluence ready";
  if (sweep) return "Stage 3: sweep detected";
  return "Stage 1: waiting session liquidity";
}

function formatEntrySignal(signal: EntrySignal) {
  return [
    `${signal.symbol} ${signal.side} ${signal.side === "LONG" ? "🟢" : "🔴"}`,
    "",
    `Confidence: ${signal.confidence}% (${signal.grade})`,
    "",
    "Reason:",
    ...signal.reasons.map((reason) => `✅ ${reason}`),
    "",
    "Entry:",
    `${fmt(signal.entry[0])}-${fmt(signal.entry[1])}`,
    "",
    "SL:",
    fmt(signal.stopLoss),
    "",
    "TP1:",
    fmt(signal.tp1),
    "",
    "TP2:",
    fmt(signal.tp2),
    "",
    "RR:",
    signal.rr.toFixed(1),
    "",
    "Setup:",
    signal.setup
  ].join("\n");
}

function sessionName(name: SessionName) {
  return name === "Asia" ? "Asian" : name;
}

function sectorIcon(name: string) {
  if (name === "AI") return "🧠";
  if (name === "Meme") return "🐸";
  if (name === "Gaming") return "🎮";
  if (name === "DeFi") return "🏦";
  if (name === "RWA") return "🏠";
  return "•";
}

function biasIcon(bias: Bias) {
  if (bias === "bullish") return "🟢";
  if (bias === "bearish") return "🔴";
  return "🟡";
}

function fmt(value: number) {
  return value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toFixed(6);
}

function shortTime(value: string) {
  return new Date(value).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
