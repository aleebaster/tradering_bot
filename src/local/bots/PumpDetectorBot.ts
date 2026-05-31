import { clamp } from "../indicators";
import { breakoutScore, directionFromCandles, fakeBreakoutRisk, liquiditySweep, momentumScore, TimedCache, volatilityExpansion, volumeQuality, volumeSpike, type IntelligenceInput, type PumpDetectorOutput } from "./shared";

export class PumpDetectorBot {
  private cache = new TimedCache<PumpDetectorOutput>(20_000);

  analyze(input: IntelligenceInput): PumpDetectorOutput {
    const key = `${input.symbol}:${input.candles["1"]?.at(-1)?.openTime ?? 0}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const m15 = input.candles["15"] ?? [];
    const m5 = input.candles["5"] ?? m15;
    const m1 = input.candles["1"] ?? m5;
    const direction = directionFromCandles(m15) === "NEUTRAL" ? directionFromCandles(m5) : directionFromCandles(m15);
    const volSpike = Math.max(volumeSpike(m1, 35), volumeSpike(m5, 24), volumeSpike(m15, 20));
    const momentumStrength = clamp(momentumScore(m15, direction) * 0.45 + momentumScore(m5, direction) * 0.35 + momentumScore(m1, direction) * 0.2);
    const breakoutProbability = clamp(breakoutScore(m15, direction) * 0.55 + breakoutScore(m5, direction) * 0.45);
    const sweep = liquiditySweep(m5, direction);
    const fakeRisk = Math.max(fakeBreakoutRisk(m15, direction, volSpike), input.orderBook.spoofRisk ? 72 : 0);
    const liquidityOk = input.liquidityScore >= 50 && input.orderBook.depthUsdt >= 150_000 && input.orderBook.spreadPct <= 0.0018;
    const btcOk = input.symbol === "BTCUSDT" || input.btcStable;
    const expansion = volatilityExpansion(m5, m15);
    const pumpScore = clamp(
      momentumStrength * 0.28 +
      breakoutProbability * 0.22 +
      Math.min(100, volSpike * 30) * 0.2 +
      expansion * 0.12 +
      volumeQuality(m15) * 0.08 +
      sweep.score * 0.1 -
      (fakeRisk > 65 ? 24 : 0) -
      (liquidityOk ? 0 : 18) -
      (btcOk ? 0 : 16)
    );
    const entryTiming = pumpScore >= 78 && fakeRisk < 62 && liquidityOk && btcOk && (sweep.reclaimed || breakoutProbability >= 70) ? "NOW" : pumpScore >= 62 && fakeRisk < 70 ? "WAIT_RETEST" : "AVOID";
    return this.cache.set(key, {
      pumpScore: Math.round(pumpScore),
      momentumStrength: Math.round(momentumStrength),
      breakoutProbability: Math.round(breakoutProbability),
      entryTiming,
      direction,
      fakeBreakoutRisk: Math.round(fakeRisk),
      reasons: [
        `volume spike ${volSpike.toFixed(2)}x`,
        `momentum ${Math.round(momentumStrength)}/100`,
        `breakout ${Math.round(breakoutProbability)}/100`,
        sweep.reclaimed ? "sweep reclaim" : sweep.swept ? "liquidity swept" : "no sweep reclaim",
        liquidityOk ? "liquidity ok" : "liquidity/spread weak",
        btcOk ? "BTC ok" : "BTC unstable"
      ]
    });
  }
}
