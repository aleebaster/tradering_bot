import type { Candle } from "./types";

export function analyzeSmc(candles: Candle[]) {
  const data = candles.slice(-60);
  if (data.length < 20) return { bos: false, choch: false, sweep: false, orderBlock: false, fvg: false, direction: 0, score: 0 };
  const last = data.at(-1)!;
  const prior = data.slice(0, -1);
  const swingHigh = Math.max(...prior.slice(-20).map((c) => c.high));
  const swingLow = Math.min(...prior.slice(-20).map((c) => c.low));
  const bosUp = last.close > swingHigh;
  const bosDown = last.close < swingLow;
  const sweepLow = last.low < swingLow && last.close > swingLow;
  const sweepHigh = last.high > swingHigh && last.close < swingHigh;
  const previousTrend = prior.at(-1)!.close > prior.at(-10)!.close ? 1 : -1;
  const direction = bosUp || sweepLow ? 1 : bosDown || sweepHigh ? -1 : previousTrend;
  const choch = (previousTrend === -1 && bosUp) || (previousTrend === 1 && bosDown);
  const displacement = Math.abs(last.close - last.open) > averageBody(data) * 1.5;
  const fvg = data.slice(-3).length === 3 && (data.at(-1)!.low > data.at(-3)!.high || data.at(-1)!.high < data.at(-3)!.low);
  const score = [bosUp || bosDown, choch, sweepLow || sweepHigh, displacement, fvg].filter(Boolean).length * 20;
  return { bos: bosUp || bosDown, choch, sweep: sweepLow || sweepHigh, orderBlock: displacement, fvg, direction, score };
}

function averageBody(candles: Candle[]) {
  return candles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / candles.length;
}
