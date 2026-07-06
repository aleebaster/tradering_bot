import { config } from "./config";
import { logger } from "./logger";
import { ExchangeClient } from "./exchanges";
import { checkAllModules, checkConfig, printBanner, printConfigCheck, printExchangeCheck, checkDemoAccount, checkLiveAccount, fullDiagnostics } from "./validation";
import { analyzeMomentumHunter, formatMomentumDashboard } from "./engines/MomentumHunterEngine";
import { btcStable, buildSignal, regimeFrom, validateSignal } from "./scoring";
import { PumpDetectorBot, WhaleTrackerBot, LiqBot, MarketReportBot } from "./bots";
import type { MarketRegime, MarketSnapshot, Signal, Candle } from "./types";

export type BotMode = "demo" | "live" | "bot" | "one" | "scan" | "dry" | "doctor" | "health";

const client = new ExchangeClient();
const pumpBot = new PumpDetectorBot();
const whaleBot = new WhaleTrackerBot();
const liqBot = new LiqBot();
const marketReportBot = new MarketReportBot();

function printHeader(step: string): void {
  logger.info(`\n----------- ${step} ${"-".repeat(Math.max(0, 41 - step.length))}`);
}

function printFooter(): void {
  logger.info("-".repeat(56) + "\n");
}

async function ensureDemoOrReject(): Promise<boolean> {
  printHeader("ACCOUNT VERIFICATION");
  const isDemo = await checkDemoAccount();
  if (isDemo) {
    logger.info("  ✓ Demo Account confirmed");
    return true;
  }
  logger.info("  ✗ Account appears to be REAL or unreachable");
  logger.info("  Use 'npm run live' for real accounts");
  return false;
}

async function requireLiveConfirmation(): Promise<boolean> {
  printHeader("LIVE ACCOUNT WARNING");
  const warning = [
    "",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "!                   WARNING                       !",
    "!                                                 !",
    "!               LIVE ACCOUNT                      !",
    "!               REAL MONEY                        !",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "",
    "  You are about to start trading on a REAL account.",
    "  All orders will be placed with real funds.",
    "",
    "  Type 'YES' to confirm: ",
    ""
  ].join("\n");
  logger.info(warning);

  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      const input = data.toString().trim().toUpperCase();
      resolve(input === "YES");
    });
  });
}

async function executeScan() {
  const symbols = config.symbols;
  const opportunities: Array<{ symbol: string; confidence: number; decision: string; reason: string }> = [];

  for (const symbol of symbols) {
    try {
      const [candles1, candles5, candles15, orderBook, funding, oi] = await Promise.all([
        client.bybitKlines(symbol, "1", "linear", 60).catch(() => []),
        client.bybitKlines(symbol, "5", "linear", 36).catch(() => []),
        client.bybitKlines(symbol, "15", "linear", 24).catch(() => []),
        client.bybitOrderBookStats(symbol, "linear").catch(() => ({ spreadPct: 0, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
        client.fundingRate(symbol).catch(() => 0),
        client.openInterestChange(symbol).catch(() => 0)
      ]);
      if (!candles1.length) continue;

      const candles: Record<string, typeof candles1> = {};
      if (candles1.length) candles["1"] = candles1;
      if (candles5.length) candles["5"] = candles5;
      if (candles15.length) candles["15"] = candles15;

      const reg: MarketRegime = "TRENDING";
      const turnover24h = 0;
      const liquidityScore = Math.min(100, Math.log10(Math.max(turnover24h, 1)) * 11);

      const result = analyzeMomentumHunter({
        symbol, candles, orderBookImbalance: orderBook.imbalance, orderBookDepthUsdt: orderBook.depthUsdt,
        orderBookSpoofRisk: orderBook.spoofRisk, fundingRate: funding, openInterestChange: oi,
        openInterestAbsolute: 0, accountRatio: 0, liquidityScore: liquidityScore || 50, regime: reg
      });

      opportunities.push({
        symbol,
        confidence: result.pumpProbability,
        decision: result.decision,
        reason: result.decisionReason
      });
    } catch {
      continue;
    }
  }

  opportunities.sort((a, b) => b.confidence - a.confidence);

  const lines = [
    "===========================================================",
    "  BEST OPPORTUNITIES",
    "==========================================================="
  ];
  opportunities.forEach((opp, i) => {
    const rank = (i + 1).toString().padStart(2);
    const icon = opp.decision === "ENTER" ? "✅" : opp.decision === "WATCH" ? "👁" : "⏸";
    lines.push("");
    lines.push(`  ${rank}. ${opp.symbol}`);
    lines.push(`     Confidence : ${opp.confidence}%`);
    lines.push(`     Decision   : ${icon} ${opp.decision}`);
    lines.push(`     Reason     : ${opp.reason}`);
    lines.push("  -----------------------------------");
  });
  lines.push("===========================================================");
  logger.info(lines.join("\n"));

  return opportunities;
}

async function buildSnapshot(symbol: string): Promise<MarketSnapshot | null> {
  try {
    const [candles, btcCandles] = await Promise.all([loadFuturesCandles(symbol), loadFuturesCandles("BTCUSDT")]);
    const btcOk = symbol === "BTCUSDT" ? true : btcStable(btcCandles);
    const [orderBook, fundingRate, openInterestChange] = await Promise.all([
      client.bybitOrderBookStats(symbol, "linear").catch(() => ({ spreadPct: 1, depthUsdt: 0, imbalance: 0, spoofRisk: false })),
      client.fundingRate(symbol).catch(() => 0),
      client.openInterestChange(symbol).catch(() => 0)
    ]);
    const primary = candles["15"] ?? [];
    const dollarVolume = primary.slice(-24).reduce((s, c) => s + c.volume * c.close, 0) / 24;
    const liquidityScore = Math.min(100, Math.log10(Math.max(dollarVolume, 1)) * 11);
    const regime = regimeFrom(candles);
    const intelligenceInput = { symbol, candles, orderBook, fundingRate, openInterestChange, liquidityScore, btcStable: btcOk, regime };
    const intelligence = {
      pump: pumpBot.analyze(intelligenceInput),
      whale: whaleBot.analyze(intelligenceInput),
      liq: liqBot.analyze(intelligenceInput),
      market: marketReportBot.analyze(intelligenceInput),
      updatedAt: new Date().toISOString()
    };
    const snapshot: MarketSnapshot = {
      symbol,
      mode: "futures",
      candles,
      okxCandles: {},
      kucoinCandles: {},
      binanceCandles: {},
      orderBookImbalance: orderBook.imbalance,
      fundingRate,
      openInterestChange,
      liquidityScore,
      whaleScore: intelligence.whale.smartMoneyScore,
      btcStable: btcOk,
      regime,
      confirmations: { bybit: true, okx: false, kucoin: false, binance: false, alignedCount: 1, conflict: false, details: ["one-shot analysis"] },
      intelligence
    };
    return snapshot;
  } catch { return null; }
}

async function buildSignalForSymbol(symbol: string): Promise<Signal | null> {
  const snapshot = await buildSnapshot(symbol);
  return snapshot ? buildSignal(snapshot) : null;
}

async function loadFuturesCandles(symbol: string) {
  const out: Record<string, Candle[]> = {};
  for (const tf of ["1", "3", "5", "15", "60"]) out[tf] = await client.bybitKlines(symbol, tf, "linear", 180);
  return out;
}

async function boot(mode: BotMode) {
  logger.level = "info";
  const modeLabel = mode === "demo" ? "DEMO" : mode === "live" ? "LIVE" : mode.toUpperCase();
  const status = mode === "scan" || mode === "doctor" || mode === "health" ? "ANALYSIS" : "TRADING";

  printBanner(modeLabel, status);

  const configResult = await checkConfig();
  if (mode !== "doctor") printConfigCheck(configResult);

  const needsPrivateApi = ["demo", "live", "bot", "one", "dry"].includes(mode);
  if (!configResult.ok && mode === "live") {
    logger.error("Config check FAILED — aborting launch");
    process.exit(1);
  }
  if (needsPrivateApi && !config.BYBIT_API_KEY) {
    logger.error("API keys required for " + mode + " mode — aborting");
    process.exit(1);
  }

  const modules = checkAllModules();
  const criticalMissing = modules.filter((m) => m.status === "MISSING");
  if (criticalMissing.length > 0) {
    logger.error({ missing: criticalMissing.map((m) => m.name) }, "Critical modules missing — aborting");
    process.exit(1);
  }

  switch (mode) {
    case "demo":
      await handleDemo();
      break;
    case "live":
      await handleLive();
      break;
    case "bot":
      await handleBot();
      break;
    case "one":
      await handleOneShot();
      break;
    case "scan":
      printHeader("SCAN ONLY MODE (no orders)");
      await executeScan();
      printFooter();
      process.exit(0);
      break;
    case "dry":
      await handleDry();
      break;
    case "doctor":
      await fullDiagnostics();
      process.exit(0);
      break;
    case "health":
      printHeader("HEALTH CHECK");
      logger.info(configResult.ok ? "  ✓ System healthy" : "  ✗ Issues detected");
      printFooter();
      process.exit(configResult.ok ? 0 : 1);
      break;
  }
}

async function handleDemo() {
  const ok = await ensureDemoOrReject();
  if (!ok) {
    logger.error("Aborting — not a demo account");
    process.exit(1);
  }

  try {
    const exchangeResult = await client.bybitWalletBalance().catch(() => null);
    if (exchangeResult) printExchangeCheck({
      ok: true, balance: { total: exchangeResult.totalWalletBalance ?? 0, available: exchangeResult.availableBalance ?? 0, equity: exchangeResult.totalWalletBalance ?? 0 },
      positions: 0, openOrders: 0, marginMode: "ISOLATED", leverage: 1
    });
  } catch { /* ok */ }

  printHeader("STARTING DEMO BOT");
  logger.info("  Mode    : Demo Trading");
  logger.info("  Market  : Bybit Futures (Demo)");
  logger.info("  Scanning: Every " + config.SCAN_INTERVAL_SECONDS + "s");
  logger.info("  Funds   : Simulated");
  printFooter();

  const { startBot } = await import("./index");
  startBot();
}

async function handleLive() {
  const confirmed = await requireLiveConfirmation();
  if (!confirmed) {
    logger.error("Aborting — live trading not confirmed");
    process.exit(1);
  }

  const exchangeResult = await client.bybitWalletBalance().catch(() => null);
  if (exchangeResult) {
    printExchangeCheck({
      ok: true,
      balance: { total: exchangeResult.totalWalletBalance ?? 0, available: exchangeResult.availableBalance ?? 0, equity: exchangeResult.totalWalletBalance ?? 0 },
      positions: 0, openOrders: 0, marginMode: "ISOLATED", leverage: 1
    });
  }

  printHeader("STARTING LIVE BOT");
  logger.info("  ⚠ LIVE TRADING — REAL FUNDS");
  logger.info("  Mode    : Live Trading");
  logger.info("  Market  : Bybit Futures");
  printFooter();

  const { startBot } = await import("./index");
  startBot();
}

async function handleBot() {
  const isDemo = await checkDemoAccount();
  if (isDemo) logger.info("  ℹ Demo account detected (continue)");

  const exchangeResult = await client.bybitWalletBalance().catch(() => null);
  if (exchangeResult) {
    printExchangeCheck({
      ok: true,
      balance: { total: exchangeResult.totalWalletBalance ?? 0, available: exchangeResult.availableBalance ?? 0, equity: exchangeResult.totalWalletBalance ?? 0 },
      positions: 0, openOrders: 0, marginMode: "ISOLATED", leverage: 1
    });
  }

  printHeader("STARTING AUTONOMOUS BOT");
  logger.info("  Mode    : Autonomous — Continuous Trading");
  logger.info("  Market  : Bybit " + (isDemo ? "Futures (Demo)" : "Futures"));
  logger.info("  Cycle   : Scan → Signal → Validate → Open → Monitor → Close → Repeat");
  logger.info("  Press Ctrl+C to stop");
  printFooter();

  const { startBot } = await import("./index");
  startBot();
}

async function handleOneShot() {
  printHeader("ONE-SHOT MODE");

  function stageLog(stage: string, status: "PASS" | "FAIL" | "SKIP", detail: string, ctx?: Record<string, unknown>) {
    const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "−";
    const prefix = ctx ? `  │ ${stage.padEnd(18)} ${icon} ${status}` : `  ${stage.padEnd(18)} ${icon} ${status}`;
    logger.info(ctx ? { ...ctx, pipelineStage: stage, stageStatus: status } : `${prefix} — ${detail}`);
    if (!ctx) logger.info(`  │ ${" ".repeat(18)} ${detail}`);
  }

  stageLog("Market Scan", "PASS", `scanning ${config.symbols.length} symbols`);

  const opportunities = await executeScan();
  const bestCand = opportunities.filter((o) => o.decision === "ENTER").sort((a, b) => b.confidence - a.confidence)[0];

  if (!bestCand) {
    stageLog("Consensus", "FAIL", "no ENTER candidates found");
    logger.info("\n  No trade opened — no candidate passed all filters");
    logger.info("  Top candidates:");
    opportunities.slice(0, 3).forEach((o) => logger.info(`    ${o.symbol}: ${o.decision} (${o.confidence}%) — ${o.reason}`));
    printFooter();
    process.exit(0);
  }

  stageLog("Consensus", "PASS", `${bestCand.symbol} confidence ${bestCand.confidence}%`, { symbol: bestCand.symbol, confidence: bestCand.confidence });

  logger.info(`\n----------- DECISION ENGINE ----------------------`);
  logger.info(`  Building full signal for ${bestCand.symbol}...`);
  const signal = await buildSignalForSymbol(bestCand.symbol);
  if (!signal) {
    stageLog("DecisionEngine", "FAIL", "failed to build signal (snapshot error)");
    logger.error(`\n  ✗ Trade FAILED: ${bestCand.symbol} — snapshot construction failed`);
    printFooter();
    process.exit(1);
  }
  const avgEntry = (signal.entry[0] + signal.entry[1]) / 2;
  stageLog("DecisionEngine", "PASS", `${signal.side} score=${signal.score} entry=${avgEntry.toFixed(2)} SL=${signal.stopLoss.toFixed(2)} TP=${signal.takeProfit[0].toFixed(2)}`, {
    symbol: signal.symbol, side: signal.side, score: signal.score, entry: avgEntry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit[0], entryStatus: signal.entryStatus
  });

  logger.info(`\n----------- VALIDATION PIPELINE ------------------`);
  const snapshot = await buildSnapshot(bestCand.symbol);
  const validation = snapshot ? validateSignal(signal, snapshot) : null;

  if (validation) {
    const offHoursCtx = { side: signal.side, confidence: signal.confidence, score: signal.score, entry: avgEntry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit[0], status: validation.offHours.pass ? "PASS" : "FAIL" };
    validation.offHours.pass
      ? stageLog("OffHoursFilter", "PASS", validation.offHours.reason, offHoursCtx)
      : stageLog("OffHoursFilter", "FAIL", validation.offHours.reason, offHoursCtx);

    const riskCtx = { side: signal.side, confidence: signal.confidence, score: signal.score, entry: avgEntry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit[0], status: validation.risk.pass ? "PASS" : "FAIL" };
    if (validation.risk.pass) {
      stageLog("RiskEngine", "PASS", validation.risk.reason, riskCtx);
    } else {
      stageLog("RiskEngine", "FAIL", validation.risk.reason, riskCtx);
    }

    const validatorCtx = { side: signal.side, confidence: signal.confidence, score: signal.score, entry: avgEntry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit[0], status: validation.validator.pass ? "PASS" : "FAIL" };
    validation.validator.pass
      ? stageLog("TradeValidator", "PASS", validation.validator.reason, validatorCtx)
      : stageLog("TradeValidator", "FAIL", validation.validator.reason, validatorCtx);
  } else {
    stageLog("Validate", "SKIP", "no snapshot available");
  }

  const validationOk = !validation || (validation.offHours.pass && validation.risk.pass && validation.validator.pass);
  if (!validationOk) {
    logger.error(`\n  ✗ Trade rejected by validation pipeline`);
    if (validation) {
      if (!validation.offHours.pass) logger.error(`    OffHoursFilter: ${validation.offHours.reason}`);
      if (!validation.risk.pass) logger.error(`    RiskEngine: ${validation.risk.reason}`);
      if (!validation.validator.pass) logger.error(`    TradeValidator: ${validation.validator.reason}`);
    }
    printFooter();
    process.exit(1);
  }

  const bybitSide = signal.side === "LONG" || signal.side === "BUY" ? "Buy" as const : "Sell" as const;
  const riskQty = validation?.risk?.adjustments?.quantity;
  let finalQty = Math.max(riskQty && riskQty > 0 ? riskQty : signal.positionSizing?.quantity ?? 0, 0);

  if (finalQty > 0 && config.safeTestMode) {
    const entryPrice = signal.currentPrice;
    if (entryPrice > 0) {
      const positionValueUsdt = finalQty * entryPrice;
      if (positionValueUsdt > config.maxPositionUsdt) {
        const cappedQty = Math.floor(config.maxPositionUsdt / entryPrice * 1e6) / 1e6;
        logger.info({
          symbol: signal.symbol,
          calculatedPosition: `${positionValueUsdt.toFixed(2)} USDT`,
          safeLimit: `${config.maxPositionUsdt.toFixed(2)} USDT`,
          finalPosition: `${(cappedQty * entryPrice).toFixed(2)} USDT`,
          reason: "SAFE_TEST_MODE"
        }, "openTrade: position capped by safe test mode");
        finalQty = cappedQty;
      }
    }
  }

  const qty = finalQty > 0 ? String(finalQty) : "0";
  const stopLoss = signal.stopLoss.toFixed(6);
  const tp1 = signal.takeProfit[0].toFixed(6);

  logger.info(`\n----------- ORDER EXECUTION ----------------------`);
  logger.info(`  Symbol     : ${signal.symbol}`);
  logger.info(`  Side       : ${bybitSide}`);
  logger.info(`  Qty        : ${qty}`);
  logger.info(`  Avg Entry  : ${avgEntry.toFixed(6)}`);
  logger.info(`  Stop Loss  : ${stopLoss}`);
  logger.info(`  Take Profit: ${tp1}`);

  const orderResult = await client.bybitPlaceOrder(signal.symbol, bybitSide, qty);
  logger.info({ retCode: orderResult.retCode, retMsg: orderResult.retMsg, orderId: orderResult.result?.orderId }, "submitOrder response");

  if (orderResult.retCode !== 0) {
    stageLog("Execution", "FAIL", `submitOrder failed: ${orderResult.retMsg}`, { symbol: signal.symbol, side: bybitSide, qty });
    logger.error(`\n  ✗ Trade FAILED: ${signal.symbol} — ${orderResult.retMsg}`);
    printFooter();
    process.exit(1);
  }

  const orderId = orderResult.result?.orderId;
  if (!orderId) {
    stageLog("Execution", "FAIL", "orderId not returned", { symbol: signal.symbol });
    logger.error(`\n  ✗ Trade FAILED: ${signal.symbol} — no orderId in response`);
    printFooter();
    process.exit(1);
  }

  logger.info(`  ✅ orderId: ${orderId}`);
  logger.info(`  Waiting for fill...`);
  await new Promise((r) => setTimeout(r, 1500));

  let position = await client.bybitGetPosition(signal.symbol);
  logger.info({ positionFound: !!position, position }, "getPosition after fill");

  if (!position || !position.size || Number(position.size) <= 0) {
    const openOrders = await client.bybitOpenOrders();
    const orderStillOpen = openOrders.find((o) => o.orderId === orderId);
    const reason = orderStillOpen ? "order still open — not filled" : "position not found after order";
    stageLog("Execution", "FAIL", reason, { symbol: signal.symbol, orderId });
    logger.error(`\n  ✗ Trade FAILED: ${signal.symbol} — ${reason}`);
    printFooter();
    process.exit(1);
  }

  logger.info(`  ✅ Position confirmed: ${position.side} ${position.size} @ ${position.avgPrice}`);

  if (signal.stopLoss > 0 || signal.takeProfit[0] > 0) {
    logger.info(`  Setting SL/TP...`);
    logger.info({ stopLoss: stopLoss, takeProfit: tp1 }, "setTradingStop params");
    const slResult = await client.bybitSetTradingStop(signal.symbol, bybitSide, stopLoss, tp1);
    logger.info({ retCode: slResult.retCode, retMsg: slResult.retMsg }, "setTradingStop response");

    if (slResult.retCode !== 0) {
      stageLog("Execution", "FAIL", `trading stop failed: ${slResult.retMsg}`, { symbol: signal.symbol });
      logger.error(`\n  ✗ Trade opened but SL/TP FAILED: ${signal.symbol} — ${slResult.retMsg}`);
      printFooter();
      process.exit(1);
    }

    logger.info(`  ✅ SL/TP set successfully`);
  } else {
    logger.info(`  ⚠ SL/TP not set — signal did not provide levels`);
  }

  await new Promise((r) => setTimeout(r, 1000));
  const verifiedPosition = await client.bybitGetPosition(signal.symbol);
  logger.info({ verifiedPosition }, "getPosition after SL/TP");

  const slOk = !verifiedPosition?.stopLoss || signal.stopLoss <= 0 || Number(verifiedPosition.stopLoss) > 0;
  const tpOk = !verifiedPosition?.takeProfit || signal.takeProfit[0] <= 0 || Number(verifiedPosition.takeProfit) > 0;

  if (!slOk || !tpOk) {
    stageLog("Execution", "FAIL", "SL/TP verification failed", { symbol: signal.symbol, orderId });
    logger.error(`\n  ✗ Trade opened but SL/TP verification FAILED`);
    printFooter();
    process.exit(1);
  }

  stageLog("Execution", "PASS", `order ${orderId} — position confirmed`, { symbol: signal.symbol, orderId, side: bybitSide });

  logger.info(`\n  ✅ Trade opened: ${signal.symbol}`);
  logger.info(`  Order ID  : ${orderId}`);
  logger.info(`  Side      : ${position.side}`);
  logger.info(`  Size      : ${position.size}`);
  logger.info(`  Entry     : ${position.avgPrice}`);
  if (verifiedPosition?.stopLoss) logger.info(`  Stop Loss : ${verifiedPosition.stopLoss}`);
  if (verifiedPosition?.takeProfit) logger.info(`  Take Profit: ${verifiedPosition.takeProfit}`);
  logger.info(`  Leverage  : ${position.leverage}`);
  logger.info(`  Confidence: ${bestCand.confidence}%`);
  logger.info(`  Decision  : ${bestCand.decision}`);
  printFooter();
  process.exit(0);
}

async function handleDry() {
  printHeader("DRY RUN MODE (simulated execution)");
  logger.info("  All operations are simulated — no real orders");
  logger.info("  Every module runs in full, except submitOrder\n");

  const { startBot } = await import("./index");
  startBot();
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith("--mode="));
  const mode = (modeArg ? modeArg.split("=")[1] : "bot") as BotMode;

  const validModes: BotMode[] = ["demo", "live", "bot", "one", "scan", "dry", "doctor", "health"];
  if (!validModes.includes(mode)) {
    logger.error(`Unknown mode: ${mode}. Valid modes: ${validModes.join(", ")}`);
    process.exit(1);
  }

  await boot(mode);
}

main().catch((err) => {
  logger.error({ err }, "Launcher failed");
  process.exit(1);
});
