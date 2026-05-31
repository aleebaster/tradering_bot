import { atr, clamp, ema } from "../indicators";
import { directionFromCandles, TimedCache, volumeQuality, type IntelligenceInput, type MarketReportOutput } from "./shared";

export class MarketReportBot {
  private cache = new TimedCache<MarketReportOutput>(30_000);

  analyze(input: IntelligenceInput): MarketReportOutput {
    const btc = input.candles["60"] ?? input.candles["15"] ?? [];
    const key = `${input.symbol}:${btc.at(-1)?.openTime ?? 0}:${input.regime}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const btcBias = directionFromCandles(btc);
    const last = btc.at(-1);
    const closes = btc.map((c) => c.close);
    const e50 = closes.length ? ema(closes, 50).at(-1) ?? closes.at(-1)! : 0;
    const volPct = last ? atr(btc.slice(-40)) / last.close : 0;
    const riskScore = clamp((input.btcStable ? 18 : 45) + Math.min(35, volPct * 1600) + Math.abs(input.fundingRate) * 20000 + (input.orderBook.spoofRisk ? 18 : 0));
    const altcoinStrength = clamp(input.liquidityScore * 0.45 + volumeQuality(input.candles["15"] ?? btc) * 0.35 + (input.openInterestChange > 0 ? 15 : 0));
    const futuresHeat = clamp(Math.abs(input.openInterestChange) * 9000 + Math.abs(input.fundingRate) * 12000 + volumeQuality(input.candles["5"] ?? btc) * 0.45);
    const riskOn = input.btcStable && btcBias === "LONG" && altcoinStrength >= 55 && riskScore < 55;
    const riskOff = !input.btcStable || btcBias === "SHORT" && last !== undefined && last.close < e50;
    const marketRegime = riskOn ? "RISK_ON" : riskOff ? "RISK_OFF" : input.regime;
    const marketAggression = clamp((riskOn ? 72 : riskOff ? 28 : 50) + (input.regime === "TRENDING" || input.regime === "BREAKOUT" ? 12 : 0) - (riskScore > 65 ? 18 : 0));
    return this.cache.set(key, {
      marketRegime,
      riskScore: Math.round(riskScore),
      marketAggression: Math.round(marketAggression),
      btcBias,
      altcoinStrength: Math.round(altcoinStrength),
      futuresHeat: Math.round(futuresHeat),
      reasons: [
        `BTC bias ${btcBias}`,
        `risk ${Math.round(riskScore)}/100`,
        `alt strength ${Math.round(altcoinStrength)}/100`,
        `futures heat ${Math.round(futuresHeat)}/100`,
        `base regime ${input.regime}`
      ]
    });
  }
}
