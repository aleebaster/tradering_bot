import { ExchangeClient } from "./exchanges";
import { atr, clamp, ema, macd, rsi, supportResistance, volumeProfileScore, vwap } from "./indicators";
import { analyzeSmc } from "./smc";
import { btcStable, regimeFrom } from "./scoring";
import type { Candle } from "./types";

export type NewTokenStatus = "SIGNAL" | "WATCHLIST" | "WAIT" | "REJECTED";

export interface NewTokenOpportunity {
  symbol: string;
  status: NewTokenStatus;
  side: "LONG" | "SHORT" | "WAIT";
  score: number;
  listedDays: number | null;
  turnover24h: number;
  spreadPct: number;
  depthUsdt: number;
  confirmations: number;
  btcStable: boolean;
  entryStatus: "ENTER_NOW" | "WAIT_FOR_RETEST" | "NO_TRADE";
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: "x2" | "x3";
  reasons: string[];
  waitingFor: string[];
  rejectionReason: string;
}

const client = new ExchangeClient();
const MIN_TURNOVER = 20_000_000;
const IDEAL_TURNOVER = 50_000_000;
const MAX_SPREAD = 0.0015;
const MIN_DEPTH = 100_000;

export async function scanBybitNewTokens(limit = 5): Promise<NewTokenOpportunity[]> {
  const [instruments, tickers] = await Promise.all([client.bybitLinearInstrumentsDetailed(), client.bybitLinearTickers()]);
  const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const candidates = instruments
    .filter((item) => item.symbol.endsWith("USDT") && item.quoteCoin === "USDT" && item.contractType.toLowerCase().includes("perpetual"))
    .filter((item) => item.status === "Trading" || item.status === "PreLaunch")
    .map((item) => ({ ...item, ticker: tickerMap.get(item.symbol), listedDays: listedDays(item.launchTime) }))
    .filter((item) => item.ticker && item.ticker.turnover24h >= MIN_TURNOVER)
    .filter((item) => item.status === "PreLaunch" || item.listedDays === null || item.listedDays <= 120)
    .sort((a, b) => candidatePriority(b) - candidatePriority(a))
    .slice(0, 12);
  const opportunities: NewTokenOpportunity[] = [];
  for (const candidate of candidates) {
    const result = await analyzeBybitNewToken(candidate.symbol).catch((error) => rejected(candidate.symbol, `Bybit new token scan error: ${error instanceof Error ? error.message : String(error)}`));
    opportunities.push(result);
    if (opportunities.filter((item) => item.status !== "REJECTED").length >= limit) break;
  }
  return opportunities.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function analyzeBybitNewToken(symbol: string): Promise<NewTokenOpportunity> {
  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized.endsWith("USDT")) return rejected(normalized, "Тільки USDT perpetual futures");
  const [instruments, tickers, btcCandles] = await Promise.all([client.bybitLinearInstrumentsDetailed(), client.bybitLinearTickers(), loadCandles("BTCUSDT")]);
  const instrument = instruments.find((item) => item.symbol === normalized);
  const ticker = tickers.find((item) => item.symbol === normalized);
  if (!instrument || instrument.quoteCoin !== "USDT" || !instrument.contractType.toLowerCase().includes("perpetual")) return rejected(normalized, "Немає Bybit USDT perpetual futures market");
  if (!ticker || ticker.turnover24h < MIN_TURNOVER) return rejected(normalized, "Недостатній futures volume: потрібно 20M+ USDT за 24h");
  if (instrument.status !== "Trading") return rejected(normalized, "PreLaunch: торгівля ще не активна, тільки моніторинг");

  const [candles, orderbook, fundingRate, oiChange] = await Promise.all([loadCandles(normalized), client.bybitOrderBookStats(normalized), client.fundingRate(normalized).catch(() => 0), client.openInterestChange(normalized).catch(() => 0)]);
  const btcOk = btcStable(btcCandles);
  const c15 = candles["15"];
  const c5 = candles["5"];
  const c1 = candles["1"];
  const last = c15.at(-1)!;
  const closes = c15.map((c) => c.close);
  const m = macd(closes);
  const rs = rsi(closes);
  const e20 = ema(closes, 20).at(-1) ?? last.close;
  const e50 = ema(closes, 50).at(-1) ?? last.close;
  const vw = vwap(c15);
  const direction = last.close > e20 && e20 > e50 && last.close > vw ? 1 : last.close < e20 && e20 < e50 && last.close < vw ? -1 : 0;
  const smc = analyzeSmc(c15);
  const sr = supportResistance(c15);
  const volatilityPct = atr(c15) / last.close;
  const recentPump = recentMove(c15, 16);
  const impulse = largestCandleMove(c15, 16);
  const retest = retestQuality(c5, direction, e20, vw, sr);
  const sniper = sniperQuality(c1, direction);
  const volume = volumeProfileScore(c15);
  const momentum = direction === 1 ? clamp((m.histogram > 0 ? 45 : 15) + (rs > 50 && rs < 70 ? 35 : 0)) : direction === -1 ? clamp((m.histogram < 0 ? 45 : 15) + (rs < 50 && rs > 30 ? 35 : 0)) : 0;
  const orderbookScore = orderbook.spreadPct <= MAX_SPREAD && orderbook.depthUsdt >= MIN_DEPTH && !orderbook.spoofRisk && Math.abs(orderbook.imbalance) <= 0.55 ? 100 : 30;
  const liquidityScore = clamp((ticker.turnover24h / IDEAL_TURNOVER) * 60 + (orderbook.depthUsdt / 250_000) * 40);
  const oiScore = clamp(50 + oiChange * 900);
  const fundingScore = clamp(100 - Math.abs(fundingRate) * 10000);
  const fakeBreakoutRisk = recentPump > 0.18 || impulse > 0.12 || orderbook.spoofRisk || volatilityPct > 0.03 || !btcOk;
  const confirmations = [volume >= 65, oiScore >= 58, momentum >= 65, liquidityScore >= 70, retest.confirmed, btcOk, orderbookScore >= 80, !fakeBreakoutRisk, sniper.confirmed].filter(Boolean).length;
  let score = clamp(volume * 0.12 + oiScore * 0.1 + fundingScore * 0.08 + momentum * 0.14 + liquidityScore * 0.16 + orderbookScore * 0.14 + retest.score * 0.12 + sniper.score * 0.08 + smc.score * 0.06 - (fakeBreakoutRisk ? 28 : 0));
  if (ticker.turnover24h < MIN_TURNOVER || orderbook.spreadPct > MAX_SPREAD || orderbook.depthUsdt < MIN_DEPTH || Math.abs(orderbook.imbalance) > 0.65) score = Math.min(score, 55);
  if (recentPump > 0.2 || impulse > 0.15 || volatilityPct > 0.035) score = Math.min(score, 55);
  if (!btcOk) score = Math.min(score, 84);
  if (confirmations < 4) score = Math.min(score, 84);
  if (!retest.confirmed || !sniper.confirmed) score = Math.min(score, 89);
  const side = direction === 1 ? "LONG" : direction === -1 ? "SHORT" : "WAIT";
  const status: NewTokenStatus = score >= 92 && confirmations >= 6 && retest.confirmed && sniper.confirmed && side !== "WAIT" ? "SIGNAL" : score >= 80 ? "WATCHLIST" : score >= 65 ? "WAIT" : "REJECTED";
  const entry = entryZone(last.close, atr(c15), direction || 1);
  const stopLoss = direction === -1 ? Math.min(sr.resistance, last.close + atr(c15) * 1.5) : Math.max(sr.support, last.close - atr(c15) * 1.5);
  const takeProfit = targets(last.close, atr(c15), direction || 1);
  return {
    symbol: normalized,
    status,
    side,
    score: Math.round(score),
    listedDays: listedDays(instrument.launchTime),
    turnover24h: ticker.turnover24h,
    spreadPct: orderbook.spreadPct,
    depthUsdt: orderbook.depthUsdt,
    confirmations,
    btcStable: btcOk,
    entryStatus: status === "SIGNAL" ? "ENTER_NOW" : status === "WATCHLIST" || status === "WAIT" ? "WAIT_FOR_RETEST" : "NO_TRADE",
    entry,
    stopLoss,
    takeProfit,
    leverage: score >= 95 && confirmations >= 7 ? "x3" : "x2",
    reasons: reasons({ ticker, orderbook, volume, oiScore, fundingScore, momentum, liquidityScore, retest, sniper, btcOk, regime: regimeFrom(candles), fakeBreakoutRisk }),
    waitingFor: waitingFor({ volume, oiScore, momentum, liquidityScore, retest, sniper, btcOk, orderbookScore, fakeBreakoutRisk }),
    rejectionReason: rejectionReason({ ticker, orderbook, btcOk, recentPump, impulse, volatilityPct, confirmations, retest, sniper, score })
  };
}

export function formatNewTokenWatch(items: NewTokenOpportunity[]) {
  if (!items.length) return ["🚀 NEW TOKENS WATCH", "", "Якісних Bybit futures new-token setup зараз немає.", "Фільтр: volume 20M+, low spread, healthy depth, BTC stable, retest/sniper only."].join("\n");
  return ["🚀 NEW TOKENS WATCH", "", ...items.map(formatNewTokenCard)].join("\n\n");
}

export function formatNewTokenCard(item: NewTokenOpportunity) {
  const header = item.status === "SIGNAL" ? `🟢 ${item.side} — ${item.symbol}` : item.score >= 85 ? `🟡 WATCHLIST — ${item.symbol}` : item.status === "WATCHLIST" ? `⚡ EARLY SETUP — ${item.symbol}` : `⏳ WAIT — ${item.symbol}`;
  return [
    header,
    "",
    `📍 Статус: ${item.status}`,
    `Score: ${item.score}/100 · confirmations ${item.confirmations}/9`,
    `Volume 24h: ${formatUsd(item.turnover24h)}`,
    `Spread: ${(item.spreadPct * 100).toFixed(3)}% · depth: ${formatUsd(item.depthUsdt)}`,
    "",
    "Причина:",
    ...item.reasons.slice(0, 6).map((reason) => `✅ ${reason}`),
    "",
    item.entryStatus === "ENTER_NOW" ? "✅ ЗАХОДИТИ ЗАРАЗ" : "Чекаємо:",
    ...(item.entryStatus === "ENTER_NOW" ? [] : item.waitingFor.slice(0, 5).map((reason) => `• ${reason}`)),
    item.entryStatus === "ENTER_NOW" ? "" : "Наступна перевірка: 5 хв",
    "",
    `📍 Вхід: ${fmt(item.entry[0])}-${fmt(item.entry[1])}`,
    `🛑 SL: ${fmt(item.stopLoss)}`,
    `🎯 TP1: ${fmt(item.takeProfit[0])}`,
    `🎯 TP2: ${fmt(item.takeProfit[1])}`,
    `⚡ Плече: ${item.leverage} максимум`,
    item.status === "REJECTED" ? `Причина відхилення: ${item.rejectionReason}` : "Risk: 1-2% account max, no FOMO."
  ].join("\n");
}

async function loadCandles(symbol: string) {
  const entries = await Promise.all(["1", "5", "15", "60", "240"].map(async (tf) => [tf, await client.bybitKlines(symbol, tf, "linear", tf === "1" ? 120 : 160)] as const));
  return Object.fromEntries(entries) as Record<string, Candle[]>;
}

function candidatePriority(item: { ticker?: { turnover24h: number; price24hPcnt: number }; listedDays: number | null; status: string }) {
  const turnover = Math.min(100, ((item.ticker?.turnover24h ?? 0) / IDEAL_TURNOVER) * 60);
  const age = item.status === "PreLaunch" ? 100 : item.listedDays === null ? 35 : clamp(100 - item.listedDays * 1.5);
  const pumpPenalty = Math.abs(item.ticker?.price24hPcnt ?? 0) > 0.18 ? 30 : 0;
  return turnover + age - pumpPenalty;
}

function listedDays(launchTime: number) {
  if (!launchTime || !Number.isFinite(launchTime)) return null;
  return Math.max(0, Math.floor((Date.now() - launchTime) / 86_400_000));
}

function recentMove(candles: Candle[], length: number) {
  const data = candles.slice(-length);
  if (data.length < 2) return 0;
  return (data.at(-1)!.close - data[0].open) / data[0].open;
}

function largestCandleMove(candles: Candle[], length: number) {
  return Math.max(0, ...candles.slice(-length).map((c) => Math.abs(c.close - c.open) / Math.max(c.open, 1e-9)));
}

function retestQuality(candles: Candle[], direction: number, e20: number, vw: number, sr: { support: number; resistance: number }) {
  const last = candles.at(-1);
  if (!last || direction === 0) return { confirmed: false, score: 0, message: "немає direction для retest" };
  const level = direction === 1 ? Math.max(e20, vw, sr.support) : Math.min(e20, vw, sr.resistance);
  const touched = direction === 1 ? last.low <= level * 1.004 && last.close > level : last.high >= level * 0.996 && last.close < level;
  const rejection = direction === 1 ? last.close > last.open && (last.close - last.low) / Math.max(last.high - last.low, 1e-9) > 0.55 : last.close < last.open && (last.high - last.close) / Math.max(last.high - last.low, 1e-9) > 0.55;
  return { confirmed: touched && rejection, score: touched && rejection ? 100 : touched ? 70 : 25, message: touched && rejection ? "clean retest + rejection" : "retest ще не підтверджений" };
}

function sniperQuality(candles: Candle[], direction: number) {
  const data = candles.slice(-20);
  const last = data.at(-1);
  if (!last || direction === 0 || data.length < 8) return { confirmed: false, score: 0, message: "немає 1M sniper trigger" };
  const priorHigh = Math.max(...data.slice(0, -1).map((c) => c.high));
  const priorLow = Math.min(...data.slice(0, -1).map((c) => c.low));
  const sweep = direction === 1 ? last.low < priorLow && last.close > priorLow : last.high > priorHigh && last.close < priorHigh;
  const vol = volumeProfileScore(data) >= 55;
  const momentum = direction === 1 ? last.close > last.open : last.close < last.open;
  return { confirmed: sweep && vol && momentum, score: sweep && vol && momentum ? 100 : sweep ? 70 : 20, message: sweep && vol && momentum ? "1M liquidity sweep + volume sniper" : "чекаємо 1M sniper trigger" };
}

function entryZone(price: number, a: number, direction: number): [number, number] {
  return direction === -1 ? [price - a * 0.1, price + a * 0.18] : [price - a * 0.18, price + a * 0.1];
}

function targets(price: number, a: number, direction: number): [number, number, number] {
  return direction === -1 ? [price - a * 1.2, price - a * 2, price - a * 3] : [price + a * 1.2, price + a * 2, price + a * 3];
}

function reasons(input: { ticker: { turnover24h: number }; orderbook: { spreadPct: number; depthUsdt: number }; volume: number; oiScore: number; fundingScore: number; momentum: number; liquidityScore: number; retest: { confirmed: boolean; message: string }; sniper: { confirmed: boolean; message: string }; btcOk: boolean; regime: string; fakeBreakoutRisk: boolean }) {
  return [
    "новий Bybit USDT perpetual candidate",
    input.ticker.turnover24h >= IDEAL_TURNOVER ? "сильний futures обсяг 50M+" : "обсяг пройшов 20M+ hard filter",
    input.oiScore >= 58 ? "OI росте без перегріву" : "OI нейтральний",
    input.fundingScore >= 80 ? "funding стабільний" : "funding не критичний",
    input.retest.confirmed ? input.retest.message : "чекаємо retest",
    input.sniper.confirmed ? input.sniper.message : "чекаємо sniper trigger",
    input.btcOk ? "BTC stable" : "BTC нестабільний",
    `режим: ${input.regime}`,
    input.fakeBreakoutRisk ? "fake breakout / pump risk активний" : "fake breakout risk низький"
  ];
}

function waitingFor(input: { volume: number; oiScore: number; momentum: number; liquidityScore: number; retest: { confirmed: boolean }; sniper: { confirmed: boolean }; btcOk: boolean; orderbookScore: number; fakeBreakoutRisk: boolean }) {
  const out: string[] = [];
  if (input.volume < 65) out.push("volume confirm");
  if (input.oiScore < 58) out.push("OI confirm");
  if (input.momentum < 65) out.push("momentum confirm");
  if (input.liquidityScore < 70 || input.orderbookScore < 80) out.push("healthy orderbook/liquidity");
  if (!input.btcOk) out.push("BTC stable");
  if (input.fakeBreakoutRisk) out.push("cooldown after pump / no FOMO");
  if (!input.retest.confirmed) out.push("retest");
  if (!input.sniper.confirmed) out.push("sniper trigger");
  return out.length ? out : ["price stays in entry zone", "risk remains controlled"];
}

function rejectionReason(input: { ticker: { turnover24h: number }; orderbook: { spreadPct: number; depthUsdt: number; spoofRisk: boolean }; btcOk: boolean; recentPump: number; impulse: number; volatilityPct: number; confirmations: number; retest: { confirmed: boolean }; sniper: { confirmed: boolean }; score: number }) {
  if (input.ticker.turnover24h < MIN_TURNOVER) return "low volume";
  if (input.orderbook.spreadPct > MAX_SPREAD) return "wide spread";
  if (input.orderbook.depthUsdt < MIN_DEPTH || input.orderbook.spoofRisk) return "thin/suspicious orderbook";
  if (!input.btcOk) return "BTC unstable";
  if (input.recentPump > 0.2 || input.impulse > 0.15) return "already pumped / FOMO candle";
  if (input.volatilityPct > 0.035) return "insane volatility";
  if (input.confirmations < 4) return "less than 4 confirmations";
  if (!input.retest.confirmed || !input.sniper.confirmed) return "WAIT: retest/sniper not confirmed";
  return `score ${Math.round(input.score)} below new-token threshold 90-95`;
}

function rejected(symbol: string, reason: string): NewTokenOpportunity {
  return { symbol, status: "REJECTED", side: "WAIT", score: 0, listedDays: null, turnover24h: 0, spreadPct: 1, depthUsdt: 0, confirmations: 0, btcStable: false, entryStatus: "NO_TRADE", entry: [0, 0], stopLoss: 0, takeProfit: [0, 0, 0], leverage: "x2", reasons: ["Bybit futures only", "strict small-account protection"], waitingFor: ["quality liquidity", "BTC stable", "retest", "sniper trigger"], rejectionReason: reason };
}

function formatUsd(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M USDT`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K USDT`;
  return `${value.toFixed(0)} USDT`;
}

function fmt(n: number) {
  if (!Number.isFinite(n) || n === 0) return "Немає";
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
