import { marketRegistry, resolvePair } from "../src/local/marketRegistry";
import { analyzeSpot } from "../src/local/spotAnalysis";
import { analyzeFutures } from "../src/local/marketAnalysis";

const spotQueries = ["BTC", "ETH", "DOGE", "SOL", "XRP", "PEPE", "SUI", "HYPE"];
const searchQueries = ["DOGE", "DOGEUSDT", "DOGE/USDT", "BTC", "PEPE", "1000PEPE", "SUI", "HYPE"];

async function main() {
  const registry = await marketRegistry(true);
  const search = await Promise.all(searchQueries.map(async (query) => ({ query, result: await resolvePair(query) })));
  const spot = await Promise.all(spotQueries.map(async (query) => ({ query, ok: await analyzeSpot(query).then((x) => Boolean(x.symbol && x.shortTerm && x.longTerm)).catch(() => false) })));
  const futures = await Promise.all(spotQueries.map(async (query) => ({ query, ok: await analyzeFutures(query).then((x) => Boolean(x.symbol && x.mode === "futures")).catch(() => false) })));
  const summary = {
    ok: registry.items.length > 100 && search.every((x) => x.result.best) && spot.every((x) => x.ok || x.query === "HYPE") && futures.every((x) => x.ok),
    registry: {
      total: registry.items.length,
      spot: registry.items.filter((x) => x.marketType === "spot").length,
      linear: registry.items.filter((x) => x.marketType === "linear").length,
      inverse: registry.items.filter((x) => x.marketType === "inverse").length,
      updatedAt: registry.updatedAt
    },
    search: search.map((x) => ({ query: x.query, best: x.result.best?.symbol, futures: x.result.futures.map((m) => m.symbol).slice(0, 3), spot: x.result.spot.map((m) => m.symbol).slice(0, 3) })),
    spot,
    futures
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
