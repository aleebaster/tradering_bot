import crypto from "node:crypto";
import WebSocket from "ws";
import { config } from "../src/local/config";

const bases = ["https://www.okx.com", "https://aws.okx.com"];
const endpoints = ["/api/v5/account/config", "/api/v5/account/balance"];

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
    hasQuotes: /^['"]|['"]$/.test(value),
    exactPassphraseMatch: value === "BotTrade2026!OKX"
  };
}

function sign(timestamp: string, method: string, path: string) {
  return crypto.createHmac("sha256", config.OKX_API_SECRET ?? "").update(`${timestamp}${method}${path}`).digest("base64");
}

async function rest(base: string, path: string) {
  const timestamp = new Date().toISOString();
  const signature = sign(timestamp, "GET", path);
  const headers = {
    "OK-ACCESS-KEY": config.OKX_API_KEY ?? "",
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": config.OKX_API_PASSPHRASE ?? "",
    "x-simulated-trading": "0"
  };
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (error) {
    return { base, endpoint: path, request: { timestamp, method: "GET", path, signature, passphraseHeader: headers["OK-ACCESS-PASSPHRASE"], keyHeaderLoaded: Boolean(headers["OK-ACCESS-KEY"]) }, response: { status: 0, raw: error instanceof Error ? error.message : String(error) } };
  }
  const raw = await res.text();
  return {
    base,
    endpoint: path,
    request: {
      timestamp,
      method: "GET",
      path,
      signature,
      passphraseHeader: headers["OK-ACCESS-PASSPHRASE"],
      keyHeaderLoaded: Boolean(headers["OK-ACCESS-KEY"])
    },
    response: { status: res.status, raw: raw.slice(0, 1000) }
  };
}

function wsLogin() {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/private");
    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({ endpoint: "wss://ws.okx.com:8443/ws/v5/private", ok: false, raw: "timeout" });
    }, 15000);
    ws.on("open", () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = crypto.createHmac("sha256", config.OKX_API_SECRET ?? "").update(`${timestamp}GET/users/self/verify`).digest("base64");
      ws.send(JSON.stringify({ op: "login", args: [{ apiKey: config.OKX_API_KEY, passphrase: config.OKX_API_PASSPHRASE, timestamp, sign: signature }] }));
    });
    ws.on("message", (message) => {
      clearTimeout(timeout);
      const raw = message.toString();
      ws.close();
      resolve({ endpoint: "wss://ws.okx.com:8443/ws/v5/private", ok: raw.includes('"code":"0"') || raw.includes('"event":"login"') && !raw.includes('error'), raw });
    });
    ws.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ endpoint: "wss://ws.okx.com:8443/ws/v5/private", ok: false, raw: error.message });
    });
  });
}

async function main() {
  const restResults = [];
  for (const base of bases) {
    for (const endpoint of endpoints) restResults.push(await rest(base, endpoint));
  }
  const ws = await wsLogin();
  console.log(JSON.stringify({
    env: {
      OKX_API_KEY: visible(config.OKX_API_KEY),
      OKX_API_SECRET: visible(config.OKX_API_SECRET),
      OKX_API_PASSPHRASE: visible(config.OKX_API_PASSPHRASE),
      legacy_OKX_PASSPHRASE_present: Boolean(process.env.OKX_PASSPHRASE)
    },
    rest: restResults,
    websocket: ws
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
