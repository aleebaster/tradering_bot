import { spawn } from "node:child_process";
import { config } from "./config";
import { state } from "./state";
import { TelegramNotifier } from "./telegram";
import { addPriorityPair, loadPriorityWatchlist, normalizePriorityPair, removePriorityPair } from "./watchlistStore";
import type { Signal } from "./types";

type TelegramUpdate = { update_id: number; message?: { text?: string; chat?: { id?: number | string } } };

export class TelegramCommandCenter {
  private enabled = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
  private notifier = new TelegramNotifier();
  private offset = 0;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (!this.enabled) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 2500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.polling || !config.TELEGRAM_BOT_TOKEN) return;
    this.polling = true;
    try {
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=1&offset=${this.offset}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
      for (const update of json.result ?? []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const chatId = String(update.message?.chat?.id ?? "");
        if (chatId !== String(config.TELEGRAM_CHAT_ID)) continue;
        const text = update.message?.text?.trim();
        if (text?.startsWith("/")) await this.handle(text);
      }
    } catch {
      // Internet/API outages are expected on laptops. Next poll will retry.
    } finally {
      this.polling = false;
    }
  }

  private async handle(text: string) {
    const [rawCommand, rawPair] = text.split(/\s+/, 2);
    const command = rawCommand.split("@")[0].toLowerCase();
    const pair = rawPair ? normalizePriorityPair(rawPair) : "";

    if (command === "/help") return this.notifier.send(helpText());
    if (command === "/status") return this.notifier.send(statusText());
    if (command === "/diagnostics") return this.notifier.send(diagnosticsText());
    if (command === "/market") return this.notifier.send(`📊 Ринок\n\n${state.marketCondition}`);
    if (command === "/btc") return this.notifier.send(btcText());
    if (command === "/positions") return this.notifier.send(positionsText());
    if (command === "/top") return this.notifier.send(topText());
    if (command === "/watchlist") return this.notifier.send(watchlistText());

    if (command === "/watch") {
      if (!pair) return this.notifier.send("Вкажи пару: /watch AIGENSYNUSDT");
      const pairs = addPriorityPair(pair);
      return this.notifier.send(["✅ Додано в моніторинг", "", `Моніторинг: ${pair}`, "", "Бот шукатиме найкращу точку входу кожні 10–15 секунд.", "", `Активний watchlist: ${pairs.join(", ")}`].join("\n"));
    }

    if (command === "/unwatch") {
      if (!pair) return this.notifier.send("Вкажи пару: /unwatch AIGENSYNUSDT");
      const pairs = removePriorityPair(pair);
      return this.notifier.send(["✅ Видалено з моніторингу", "", pair, "", pairs.length ? `Активний watchlist: ${pairs.join(", ")}` : "Watchlist порожній"].join("\n"));
    }

    if (command === "/signal") {
      if (!pair) return this.notifier.send("Вкажи пару: /signal BTCUSDT");
      addPriorityPair(pair);
      startOneShotAnalysis(pair);
      return this.notifier.send(["✅ Аналіз запущено", "", pair, "", "Пара додана в постійний моніторинг.", "Бот повідомить тільки коли з'явиться валідний сетап."].join("\n"));
    }

    return this.notifier.send("Невідома команда. Напиши /help");
  }
}

function startOneShotAnalysis(pair: string) {
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/manual-aigensyn-bybit.ts", pair], {
    cwd: process.cwd(),
    env: { ...process.env, PAIR: pair },
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
}

function helpText() {
  return [
    "📌 Команди",
    "",
    "/signal BTCUSDT — аналіз пари + постійний моніторинг",
    "/watch AIGENSYNUSDT — додати в watchlist",
    "/unwatch AIGENSYNUSDT — прибрати з watchlist",
    "/watchlist — список пар",
    "/top — найкращі сетапи зараз",
    "/market — стан ринку",
    "/btc — BTC фільтр",
    "/status — статус сканера",
    "/positions — активні угоди",
    "/diagnostics — API і біржі",
    "/help — список команд"
  ].join("\n");
}

function statusText() {
  return [
    "🟢 Статус сканера",
    "",
    `Режим: ${state.diagnostics.mode}`,
    `Останній scan: ${state.diagnostics.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "очікується"}`,
    `Символів: ${state.diagnostics.scannedSymbols}`,
    `Сигналів сьогодні: ${state.stats.signalsToday}`,
    `Watchlist: ${loadPriorityWatchlist().join(", ") || "порожній"}`
  ].join("\n");
}

function diagnosticsText() {
  const api = Object.entries(state.diagnostics.apiStatus).map(([key, value]) => `${key}: ${value}`);
  const errors = Object.entries(state.diagnostics.authErrors).map(([key, value]) => `${key}: ${value}`);
  return ["🛠 Діагностика", "", ...api, ...(errors.length ? ["", "Помилки:", ...errors] : [])].join("\n");
}

function btcText() {
  const latest = [...state.activeSignals, ...state.watchlist, ...state.history].find((signal) => signal.symbol === "BTCUSDT" || signal.btcStable !== undefined);
  return ["₿ BTC фільтр", "", latest?.btcStable ? "✅ BTC стабільний" : "⚠️ BTC нестабільний або ще немає даних", `Ринок: ${state.marketCondition}`].join("\n");
}

function positionsText() {
  if (!state.activeSignals.length) return "📦 Активні угоди\n\nНемає активних угод.";
  return ["📦 Активні угоди", "", ...state.activeSignals.slice(0, 8).map(signalSummary)].join("\n\n");
}

function topText() {
  const top = [...state.activeSignals, ...state.watchlist, ...state.history].filter((signal) => signal.side !== "NO_TRADE").sort((a, b) => b.score - a.score).slice(0, 5);
  if (!top.length) return "🏆 Топ сетапи\n\nПоки немає валідних сетапів.";
  return ["🏆 Топ сетапи", "", ...top.map(signalSummary)].join("\n\n");
}

function watchlistText() {
  const pairs = loadPriorityWatchlist();
  return ["👁 Watchlist", "", ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["Watchlist порожній"])].join("\n");
}

function signalSummary(signal: Signal) {
  const side = signal.side === "BUY" ? "LONG" : signal.side;
  return `${side} ${signal.symbol}\nScore: ${signal.score}/100 · ${signal.entryStatus}\nEntry: ${fmt(signal.entry[0])}–${fmt(signal.entry[1])}`;
}

function fmt(n: number) {
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
}
