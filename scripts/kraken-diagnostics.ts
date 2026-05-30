import WebSocket from "ws";
import { config } from "../src/local/config";
import { ExchangeClient } from "../src/local/exchanges";

const client = new ExchangeClient();
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

function visible(value: string | undefined) {
  if (!value) return { loaded: false };
  return {
    loaded: true,
    length: value.length,
    startsWith: value.slice(0, 4),
    endsWith: value.slice(-4),
    hasLeadingSpace: value !== value.trimStart(),
    hasTrailingSpace: value !== value.trimEnd(),
    hasNewline: /[\r\n]/.test(value),
    hasQuotes: /^['"]|['"]$/.test(value)
  };
}

async function safe<T>(fn: () => Promise<T>) {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function websocketCheck() {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws.kraken.com/v2");
    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, raw: "timeout" });
    }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USDT"] } })));
    ws.on("message", (message) => {
      const raw = message.toString();
      if (raw.includes("ticker") || raw.includes("error")) {
        clearTimeout(timeout);
        ws.close();
        resolve({ ok: raw.includes("ticker") && !raw.includes("error"), raw: raw.slice(0, 1000) });
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, raw: error.message });
    });
  });
}

async function main() {
  const spotMarkets = Object.fromEntries(await Promise.all(symbols.map(async (symbol) => [symbol, await safe(async () => (await client.krakenSpotKlines(symbol, "15", 5)).length)])));
  const futuresMarkets = Object.fromEntries(await Promise.all(symbols.map(async (symbol) => [symbol, await safe(() => client.krakenFuturesTicker(symbol))])));
  const result = {
    env: {
      KRAKEN_SPOT_API_KEY: visible(config.KRAKEN_SPOT_API_KEY),
      KRAKEN_SPOT_API_SECRET: visible(config.KRAKEN_SPOT_API_SECRET),
      KRAKEN_FUTURES_API_KEY: visible(config.KRAKEN_FUTURES_API_KEY),
      KRAKEN_FUTURES_API_SECRET: visible(config.KRAKEN_FUTURES_API_SECRET)
    },
    spotAuth: await safe(() => client.krakenSpotAuthCheck()),
    futuresAuth: await safe(() => client.krakenFuturesAuthCheck()),
    spotMarkets,
    futuresMarkets,
    websocket: await websocketCheck()
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
