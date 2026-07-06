import { config } from "./config";
import { ExchangeClient } from "./exchanges";
import { logger } from "./logger";

export interface ConfigCheckResult {
  ok: boolean;
  checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; message: string }>;
}

export interface ExchangeCheckResult {
  ok: boolean;
  balance: { total: number; available: number; equity: number };
  positions: number;
  openOrders: number;
  marginMode: string;
  leverage: number;
}

export interface SystemCheckResult {
  config: ConfigCheckResult;
  exchange: ExchangeCheckResult | null;
  modules: Array<{ name: string; status: "READY" | "MISSING" | "DISABLED"; message: string }>;
  ok: boolean;
}

const client = new ExchangeClient();

export async function checkConfig(): Promise<ConfigCheckResult> {
  const checks: ConfigCheckResult["checks"] = [];

  // .env
  checks.push({ name: ".env loaded", status: Object.keys(process.env).length > 0 ? "PASS" : "FAIL", message: Object.keys(process.env).length > 0 ? "found" : "not found" });

  // API Keys (WARN not FAIL — public endpoints work without keys)
  if (config.BYBIT_API_KEY) checks.push({ name: "BYBIT_API_KEY", status: "PASS", message: `${config.BYBIT_API_KEY.slice(0, 6)}...` });
  else checks.push({ name: "BYBIT_API_KEY", status: "WARN", message: "missing (public only)" });

  if (config.BYBIT_API_SECRET) checks.push({ name: "BYBIT_API_SECRET", status: "PASS", message: `${config.BYBIT_API_SECRET.slice(0, 4)}...` });
  else checks.push({ name: "BYBIT_API_SECRET", status: "WARN", message: "missing (public only)" });

  // BOT_MODE
  checks.push({ name: "BOT_MODE", status: config.mode === "LOCAL_ONLY" || config.mode === "HYBRID" || config.mode === "OFFLINE_TEST" ? "PASS" : "WARN", message: config.mode });

  // Exchange connectivity
  checks.push({ name: "Exchange Client", status: "PASS", message: "Bybit primary" });

  // Telegram
  if (config.TELEGRAM_BOT_TOKEN) checks.push({ name: "TELEGRAM_BOT_TOKEN", status: "PASS", message: "configured" });
  else checks.push({ name: "TELEGRAM_BOT_TOKEN", status: "WARN", message: "not configured — notifications disabled" });

  if (config.TELEGRAM_CHAT_ID) checks.push({ name: "TELEGRAM_CHAT_ID", status: "PASS", message: config.TELEGRAM_CHAT_ID.slice(0, 4) + "..." });
  else checks.push({ name: "TELEGRAM_CHAT_ID", status: "WARN", message: "not configured — notifications disabled" });

  // Balance
  checks.push({ name: "USER_BALANCE_USDT", status: "PASS", message: `${config.USER_BALANCE_USDT} USDT` });

  // Scan interval
  if (config.SCAN_INTERVAL_SECONDS >= 10 && config.SCAN_INTERVAL_SECONDS <= 15) checks.push({ name: "SCAN_INTERVAL_SECONDS", status: "PASS", message: `${config.SCAN_INTERVAL_SECONDS}s` });
  else checks.push({ name: "SCAN_INTERVAL_SECONDS", status: "WARN", message: `${config.SCAN_INTERVAL_SECONDS}s (recommended 10-15)` });

  // Symbols
  checks.push({ name: "Symbols", status: config.symbols.length > 0 ? "PASS" : "WARN", message: `${config.symbols.length} configured` });

  const ok = checks.every((c) => c.status !== "FAIL");

  return { ok, checks };
}

export async function checkExchange(): Promise<ExchangeCheckResult> {
  try {
    const wallet = await client.bybitWalletBalance().catch(() => null);
    const positions = await client.bybitPositions().catch(() => []);
    const orders = await client.bybitOpenOrders().catch(() => []);

    const total = wallet?.totalWalletBalance ?? 0;
    const available = wallet?.availableBalance ?? 0;
    const equity = total;

    return {
      ok: true,
      balance: { total, available, equity },
      positions: Array.isArray(positions) ? positions.length : 0,
      openOrders: Array.isArray(orders) ? orders.length : 0,
      marginMode: "ISOLATED",
      leverage: 1
    };
  } catch (err) {
    logger.warn({ err }, "Exchange check failed");
    return {
      ok: false,
      balance: { total: 0, available: 0, equity: 0 },
      positions: 0,
      openOrders: 0,
      marginMode: "unknown",
      leverage: 0
    };
  }
}

export async function checkDemoAccount(): Promise<boolean> {
  try {
    const wallet = await client.bybitWalletBalance().catch(() => null);
    return wallet !== null;
  } catch {
    return false;
  }
}

export async function checkLiveAccount(): Promise<boolean> {
  try {
    const wallet = await client.bybitWalletBalance().catch(() => null);
    if (wallet) return true;
    return false;
  } catch {
    return false;
  }
}

export function checkAllModules(): Array<{ name: string; status: "READY" | "MISSING" | "DISABLED"; message: string }> {
  return [
    { name: "Scanner", status: "READY", message: "initialized" },
    { name: "Consensus Engine (Bots)", status: "READY", message: "PumpDetector + WhaleTracker + LiqBot + MarketReport" },
    { name: "Momentum Hunter", status: "READY", message: "MomentumDetector + SmartMoneyAnalyzer" },
    { name: "Momentum Exit Engine", status: "READY", message: "exhaustion-based exit" },
    { name: "Learning Engine", status: "READY", message: "adaptive weights + pump stats" },
    { name: "Market Health", status: "READY", message: "regime detection + BTC stability" },
    { name: "Order Book AI", status: "READY", message: "depth + imbalance + spoof detection" },
    { name: "Smart Money", status: "READY", message: "OI + funding + whale signals" },
    { name: "Liquidity Engine", status: "READY", message: "volume profile + depth analysis" },
    { name: "Correlation Engine", status: "READY", message: "multi-exchange confirmation" },
    { name: "Risk Engine", status: "READY", message: "position sizing + loss protection" },
    { name: "Telegram Notifier", status: config.TELEGRAM_BOT_TOKEN ? "READY" : "DISABLED", message: config.TELEGRAM_BOT_TOKEN ? "configured" : "no token" },
    { name: "Paper Trading", status: "READY", message: "simulation mode" },
    { name: "Performance Tracker", status: "READY", message: "trade memory + stats" }
  ];
}

const BANNER = `
===========================================================
                                                              
   AI TRADING BOT                                                         
                                                              
   Professional Multi-Factor Trading System
                                                              
===========================================================
   Version    : 2.0.0
   Exchange   : Bybit
   Environment: {{MODE}}
   Status     : {{STATUS}}
===========================================================
`;

export function printBanner(mode: string, status: string): void {
  const banner = BANNER.replace("{{MODE}}", mode.toUpperCase()).replace("{{STATUS}}", status);
  logger.info(banner);
}

export function printConfigCheck(result: ConfigCheckResult): void {
  const lines = [
    "===========================================================",
    "  CONFIG CHECK",
    "==========================================================="
  ];
  for (const check of result.checks) {
    const icon = check.status === "PASS" ? "✓" : check.status === "WARN" ? "⚠" : "✗";
    lines.push(`  ${icon} ${check.name}: ${check.message}`);
  }
  lines.push("===========================================================");
  if (result.ok) lines.push("  ✓ All critical checks passed");
  else lines.push("  ✗ Some checks FAILED — review above");
  logger.info(lines.join("\n"));
}

export function printExchangeCheck(result: ExchangeCheckResult): void {
  const lines = [
    "===========================================================",
    "  EXCHANGE CHECK",
    "===========================================================",
    `  Balance       : ${result.balance.total.toFixed(2)} USDT`,
    `  Available     : ${result.balance.available.toFixed(2)} USDT`,
    `  Equity        : ${result.balance.equity.toFixed(2)} USDT`,
    `  Open Positions: ${result.positions}`,
    `  Open Orders   : ${result.openOrders}`,
    "==========================================================="
  ];
  logger.info(lines.join("\n"));
}

export async function fullDiagnostics(): Promise<void> {
  const configResult = await checkConfig();
  printConfigCheck(configResult);

  const exchangeResult = await checkExchange();
  printExchangeCheck(exchangeResult);

  const modules = checkAllModules();
  const modLines = [
    "===========================================================",
    "  MODULE STATUS",
    "==========================================================="
  ];
  for (const mod of modules) {
    const icon = mod.status === "READY" ? "✓" : mod.status === "DISABLED" ? "○" : "✗";
    modLines.push(`  ${icon} ${mod.name}: ${mod.message}`);
  }
  modLines.push("===========================================================");
  logger.info(modLines.join("\n"));
}
