import type { Candle } from "./types";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

export function macd(values: number[]) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => (fast[i] ?? 0) - (slow[i] ?? 0));
  const signal = ema(line, 9);
  return { line: line.at(-1) ?? 0, signal: signal.at(-1) ?? 0, histogram: (line.at(-1) ?? 0) - (signal.at(-1) ?? 0) };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function vwap(candles: Candle[]): number {
  const data = candles.slice(-48);
  const pv = data.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = data.reduce((sum, c) => sum + c.volume, 0);
  return vol ? pv / vol : data.at(-1)?.close ?? 0;
}

export function supportResistance(candles: Candle[]) {
  const data = candles.slice(-80);
  const support = Math.min(...data.map((c) => c.low));
  const resistance = Math.max(...data.map((c) => c.high));
  return { support, resistance, mid: (support + resistance) / 2 };
}

export function volumeProfileScore(candles: Candle[]): number {
  const data = candles.slice(-30);
  const avg = data.reduce((s, c) => s + c.volume, 0) / Math.max(data.length, 1);
  const last = data.at(-1)?.volume ?? avg;
  return clamp((last / Math.max(avg, 1)) * 50, 0, 100);
}

export function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
