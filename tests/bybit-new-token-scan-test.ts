import { analyzeBybitNewToken, scanBybitNewTokens } from "../src/local/newTokenScanner";

async function main() {
  const watch = await scanBybitNewTokens(3);
  const first = watch[0]?.symbol ?? "BTCUSDT";
  const analysis = await analyzeBybitNewToken(first);
  const checks = {
    arrayReturned: Array.isArray(watch),
    bybitFuturesOnly: analysis.symbol.endsWith("USDT"),
    strictThreshold: analysis.status !== "SIGNAL" || analysis.score >= 92,
    smallAccountLeverage: analysis.leverage === "x2" || analysis.leverage === "x3",
    noBlindTrade: analysis.entryStatus !== "ENTER_NOW" || analysis.waitingFor.length <= 2
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  console.log(JSON.stringify({ ok: failed.length === 0, scanned: watch.length, analyzed: analysis.symbol, status: analysis.status, score: analysis.score, confirmations: analysis.confirmations, checks, failed }, null, 2));
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
