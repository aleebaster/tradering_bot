import { clamp } from "../indicators";
import { directionFromCandles, liquiditySweep, momentumScore, TimedCache, volumeSpike, type DirectionBias, type IntelligenceInput, type LiqBotOutput } from "./shared";

export class LiqBot {
  private cache = new TimedCache<LiqBotOutput>(15_000);

  analyze(input: IntelligenceInput): LiqBotOutput {
    const key = `${input.symbol}:${input.candles["1"]?.at(-1)?.openTime ?? 0}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const m1 = input.candles["1"] ?? input.candles["5"] ?? [];
    const m5 = input.candles["5"] ?? input.candles["15"] ?? [];
    const htfDirection = directionFromCandles(input.candles["15"] ?? m5);
    const longSweep = liquiditySweep(m5, "LONG");
    const shortSweep = liquiditySweep(m5, "SHORT");
    const sweepDirection: DirectionBias = longSweep.score > shortSweep.score && longSweep.swept ? "LONG" : shortSweep.score > longSweep.score && shortSweep.swept ? "SHORT" : htfDirection;
    const sweep = sweepDirection === "LONG" ? longSweep : sweepDirection === "SHORT" ? shortSweep : { swept: false, reclaimed: false, score: 0 };
    const vol = Math.max(volumeSpike(m1), volumeSpike(m5));
    const momentum = momentumScore(m1, sweepDirection) * 0.45 + momentumScore(m5, sweepDirection) * 0.55;
    const oiFlush = Math.abs(input.openInterestChange) > 0.0012;
    const trapProbability = clamp((sweep.swept && !sweep.reclaimed ? 45 : 12) + (input.orderBook.spoofRisk ? 25 : 0) + (vol < 0.8 ? 12 : 0));
    const liqSignalStrength = clamp(sweep.score * 0.36 + momentum * 0.24 + Math.min(100, vol * 28) * 0.18 + (oiFlush ? 16 : 0) + (input.btcStable || input.symbol === "BTCUSDT" ? 8 : -12) - trapProbability * 0.22);
    const entryQuality = clamp(liqSignalStrength + (sweep.reclaimed ? 16 : -10) - trapProbability * 0.3);
    return this.cache.set(key, {
      liqSignalStrength: Math.round(liqSignalStrength),
      sweepDirection,
      trapProbability: Math.round(trapProbability),
      entryQuality: Math.round(entryQuality),
      reclaimConfirmed: sweep.reclaimed,
      reasons: [
        sweep.swept ? `${sweepDirection} sweep detected` : "no liquidation sweep",
        sweep.reclaimed ? "fast reclaim confirmed" : "reclaim not confirmed",
        `volume ${vol.toFixed(2)}x`,
        oiFlush ? "OI flush/expansion" : "OI normal",
        `trap ${Math.round(trapProbability)}/100`
      ]
    });
  }
}
