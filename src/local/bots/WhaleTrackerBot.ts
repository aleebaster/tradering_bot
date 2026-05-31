import { clamp } from "../indicators";
import { directionSign, TimedCache, volumeSpike, type DirectionBias, type IntelligenceInput, type WhaleTrackerOutput } from "./shared";

export class WhaleTrackerBot {
  private cache = new TimedCache<WhaleTrackerOutput>(20_000);

  analyze(input: IntelligenceInput): WhaleTrackerOutput {
    const key = `${input.symbol}:${input.candles["5"]?.at(-1)?.openTime ?? 0}:${input.orderBook.imbalance.toFixed(2)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const m5 = input.candles["5"] ?? input.candles["15"] ?? [];
    const m15 = input.candles["15"] ?? m5;
    const last = m5.at(-1);
    const oiAbs = Math.abs(input.openInterestChange);
    const ob = input.orderBook.imbalance;
    const buyPressure = ob > 0.08;
    const sellPressure = ob < -0.08;
    const priceChange = m15.length >= 8 && last ? (last.close - m15.at(-8)!.close) / m15.at(-8)!.close : 0;
    const absorptionLong = input.openInterestChange > 0.001 && priceChange >= -0.004 && buyPressure;
    const absorptionShort = input.openInterestChange > 0.001 && priceChange <= 0.004 && sellPressure;
    const distribution = input.openInterestChange > 0.0015 && priceChange > 0.006 && sellPressure;
    const accumulation = input.openInterestChange > 0.0015 && priceChange < -0.006 && buyPressure;
    const whaleBias: DirectionBias = absorptionLong || accumulation ? "LONG" : absorptionShort || distribution ? "SHORT" : buyPressure ? "LONG" : sellPressure ? "SHORT" : "NEUTRAL";
    const alignedPressure = Math.abs(ob) * 120;
    const smartMoneyScore = clamp(35 + alignedPressure + Math.min(30, oiAbs * 8000) + (volumeSpike(m5) > 1.5 ? 12 : 0) - (input.orderBook.spoofRisk ? 18 : 0));
    const trapRisk = clamp((input.orderBook.spoofRisk ? 45 : 10) + (distribution || accumulation ? 22 : 0) + (Math.abs(input.fundingRate) > 0.00035 ? 18 : 0));
    const biasSign = directionSign(whaleBias);
    const whaleConfidence = clamp(smartMoneyScore + (biasSign !== 0 ? 12 : -8) - trapRisk * 0.25);
    return this.cache.set(key, {
      whaleBias,
      whaleConfidence: Math.round(whaleConfidence),
      smartMoneyScore: Math.round(smartMoneyScore),
      trapRisk: Math.round(trapRisk),
      accumulation,
      distribution,
      reasons: [
        `orderbook imbalance ${ob.toFixed(2)}`,
        `OI change ${(input.openInterestChange * 100).toFixed(2)}%`,
        `funding ${input.fundingRate}`,
        accumulation ? "accumulation" : distribution ? "distribution" : absorptionLong || absorptionShort ? "absorption" : "no clear absorption",
        input.orderBook.spoofRisk ? "spoof wall risk" : "walls normal"
      ]
    });
  }
}
