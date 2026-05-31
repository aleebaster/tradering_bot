"use client";

import { useEffect, useMemo, useState } from "react";

type Alert = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT" | "WATCH";
  score: number;
  probability: number;
  price: number;
  change24h: number;
  volumeUsdt: number;
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: string;
  riskReward: string;
  status: "ENTER_NOW" | "WAIT" | "WATCH";
  reasons: string[];
  heat: "hot" | "warm" | "cold";
  exchangeUrl: string;
  createdAt: string;
};

type MarketResponse = {
  ok: boolean;
  generatedAt: string;
  fearGreed: { value: number; label: string };
  marketPulse: string;
  stats: { scanned: number; enterNow: number; watch: number; avgScore: number };
  alerts: Alert[];
};

const localApiUrl = (process.env.NEXT_PUBLIC_LOCAL_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export default function Home() {
  const [data, setData] = useState<MarketResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "enter" | "long" | "short" | "watch">("all");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"night" | "day">("night");
  const [botStatus, setBotStatus] = useState("Перевіряю локальний бот...");
  const [notifyStatus, setNotifyStatus] = useState("");

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/market/alerts", { cache: "no-store" });
        const json = await res.json();
        if (alive && json.ok) setData(json);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  useEffect(() => {
    let alive = true;
    async function checkLocalBot() {
      const hosted = !["localhost", "127.0.0.1"].includes(window.location.hostname);
      if (hosted && localApiUrl.includes("localhost")) {
        setBotStatus("Vercel-сайт працює. Для live-даних локального бота запусти START_BOT.bat на Windows або вкажи HTTPS API в NEXT_PUBLIC_LOCAL_API_URL.");
        return;
      }
      try {
        const res = await fetch(`${localApiUrl}/state`, { cache: "no-store" });
        if (!res.ok) throw new Error("offline");
        const state = await res.json();
        if (alive) setBotStatus(`Бот підключено. Останній скан: ${state.diagnostics?.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "очікується"}.`);
      } catch {
        if (alive) setBotStatus("Локальний рушій не відповідає. Сайт усе одно показує Vercel live-аналітику з Binance public API.");
      }
    }
    void checkLocalBot();
    return () => { alive = false; };
  }, []);

  const alerts = useMemo(() => {
    const all = data?.alerts ?? [];
    return all.filter((alert) => {
      if (filter === "enter" && alert.status !== "ENTER_NOW") return false;
      if (filter === "long" && alert.side !== "LONG") return false;
      if (filter === "short" && alert.side !== "SHORT") return false;
      if (filter === "watch" && alert.status === "ENTER_NOW") return false;
      if (query && !alert.symbol.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [data, filter, query]);

  const top = data?.alerts[0];

  async function notify(alert: Alert) {
    setNotifyStatus("Надсилаю в Telegram...");
    const res = await fetch("/api/telegram/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alert) });
    setNotifyStatus(res.ok ? `Надіслано в Telegram: ${alert.symbol}` : "Telegram не налаштований або повернув помилку");
  }

  return (
    <main className={theme === "day" ? "theme-day min-h-screen" : "min-h-screen"}>
      <section className="relative overflow-hidden px-4 py-5 md:px-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(0,229,255,.22),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(192,64,255,.22),transparent_26%),linear-gradient(180deg,rgba(7,9,26,.2),rgba(7,9,26,1))]" />
        <div className="relative mx-auto max-w-7xl">
          <nav className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[.04] px-4 py-3 backdrop-blur-xl">
            <div>
              <p className="text-xs uppercase tracking-[0.45em] text-cyan-300">CryptobuyBots style</p>
              <h1 className="mt-1 text-2xl font-black md:text-4xl">Live Crypto Signal Radar</h1>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-profit/40 bg-profit/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.25em] text-profit"><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-profit" />Live</span>
              <button onClick={() => setTheme(theme === "night" ? "day" : "night")} className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-200 transition hover:border-cyan-300/60">{theme === "night" ? "Light" : "Dark"}</button>
            </div>
          </nav>

          <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
            <section className="rounded-[2rem] border border-cyan-300/20 bg-black/30 p-5 shadow-[0_0_80px_rgba(0,229,255,.08)] backdrop-blur-xl md:p-7">
              <p className="text-sm uppercase tracking-[0.35em] text-slate-400">AI trade scanner</p>
              <h2 className="mt-3 text-4xl font-black leading-tight md:text-6xl">Сайт для сигналів, які реально варто перевірити перед входом</h2>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">Дашборд сканує топові монети, оцінює тренд, імпульс, RSI, ліквідність і показує зони входу, SL/TP та ймовірність. Сильні сетапи можна відправити у твій Telegram-бот одним кліком.</p>
              <div className="mt-6 grid gap-3 md:grid-cols-4">
                <Metric label="Проскановано" value={String(data?.stats.scanned ?? 0)} />
                <Metric label="Enter now" value={String(data?.stats.enterNow ?? 0)} accent="text-profit" />
                <Metric label="Avg score" value={`${data?.stats.avgScore ?? 0}/100`} />
                <Metric label="Fear & Greed" value={data ? `${data.fearGreed.value} ${data.fearGreed.label}` : "--"} accent={fearColor(data?.fearGreed.value ?? 50)} />
              </div>
              <div className="mt-5 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">{botStatus}</div>
            </section>

            <section className="grid gap-4">
              <div className="rounded-[2rem] border border-purple-400/20 bg-white/[.04] p-5 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.3em] text-purple-300">Market pulse</p>
                <p className="mt-3 text-2xl font-black">{loading ? "Завантаження live-ринку..." : data?.marketPulse}</p>
                {top ? <TopSignal alert={top} onNotify={() => void notify(top)} /> : <p className="mt-4 text-slate-400">Очікую перший пакет даних...</p>}
                {notifyStatus ? <p className="mt-3 text-sm text-cyan-200">{notifyStatus}</p> : null}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Mini label="Hot" value={String(data?.alerts.filter((a) => a.heat === "hot").length ?? 0)} />
                <Mini label="Long" value={String(data?.alerts.filter((a) => a.side === "LONG").length ?? 0)} />
                <Mini label="Short" value={String(data?.alerts.filter((a) => a.side === "SHORT").length ?? 0)} />
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-10 md:px-8">
        <div className="sticky top-0 z-20 -mx-4 mb-4 border-y border-white/10 bg-obsidian/85 px-4 py-3 backdrop-blur-xl md:-mx-8 md:px-8">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>Всі</FilterButton>
            <FilterButton active={filter === "enter"} onClick={() => setFilter("enter")}>Enter now</FilterButton>
            <FilterButton active={filter === "long"} onClick={() => setFilter("long")}>Long</FilterButton>
            <FilterButton active={filter === "short"} onClick={() => setFilter("short")}>Short</FilterButton>
            <FilterButton active={filter === "watch"} onClick={() => setFilter("watch")}>Watch</FilterButton>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="BTC, ETH, SOL..." className="ml-auto min-w-48 rounded-full border border-white/10 bg-white/[.04] px-4 py-2 text-sm outline-none ring-cyan-300/30 transition focus:ring-4" />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {alerts.map((alert) => <SignalCard key={alert.id} alert={alert} onNotify={() => void notify(alert)} />)}
          {!alerts.length ? <div className="rounded-3xl border border-white/10 p-8 text-center text-slate-400">Немає сигналів під цей фільтр.</div> : null}
        </div>
      </section>
    </main>
  );
}

function SignalCard({ alert, onNotify }: { alert: Alert; onNotify: () => void }) {
  return (
    <article className={`group relative overflow-hidden rounded-3xl border p-5 transition hover:-translate-y-1 ${alert.heat === "hot" ? "border-profit/40 bg-profit/[.06] shadow-[0_0_45px_rgba(53,241,163,.08)]" : alert.side === "SHORT" ? "border-danger/30 bg-danger/[.05]" : "border-white/10 bg-white/[.035]"}`}>
      <div className="absolute right-4 top-4 h-24 w-24 rounded-full bg-cyan-300/10 blur-3xl transition group-hover:bg-purple-400/20" />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-slate-400">{alert.status === "ENTER_NOW" ? "Угода в зоні входу" : alert.status === "WAIT" ? "Чекати зону" : "Watchlist"}</p>
          <h3 className="mt-2 text-3xl font-black">{alert.symbol.replace("USDT", "")} <span className={sideClass(alert.side)}>{alert.side}</span></h3>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-right">
          <p className="text-xs text-slate-400">Score</p>
          <p className="text-2xl font-black text-white">{alert.score}<span className="text-sm text-slate-500">/100</span></p>
        </div>
      </div>

      <div className="relative mt-4 grid gap-3 md:grid-cols-4">
        <Row label="Ціна" value={fmt(alert.price)} />
        <Row label="24h" value={`${alert.change24h >= 0 ? "+" : ""}${alert.change24h.toFixed(2)}%`} color={alert.change24h >= 0 ? "text-profit" : "text-danger"} />
        <Row label="Ймовірність" value={`${alert.probability}%`} />
        <Row label="Плече" value={alert.leverage} />
        <Row label="Вхід" value={`${fmt(alert.entry[0])}–${fmt(alert.entry[1])}`} />
        <Row label="Stop Loss" value={fmt(alert.stopLoss)} color="text-danger" />
        <Row label="Take Profit" value={alert.takeProfit.map(fmt).join(" / ")} color="text-profit" />
        <Row label="R/R" value={alert.riskReward} />
      </div>

      <div className="relative mt-4 flex flex-wrap gap-2">
        {alert.reasons.map((reason) => <span key={reason} className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-slate-300">{reason}</span>)}
      </div>

      <div className="relative mt-5 flex flex-wrap gap-3">
        <a href={alert.exchangeUrl} target="_blank" rel="noreferrer" className="rounded-full bg-white px-5 py-2 text-sm font-black text-black transition hover:bg-cyan-200">Відкрити пару</a>
        <button onClick={onNotify} className="rounded-full border border-cyan-300/40 px-5 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-300/10">Надіслати в Telegram</button>
      </div>
    </article>
  );
}

function TopSignal({ alert, onNotify }: { alert: Alert; onNotify: () => void }) {
  return (
    <div className="mt-5 rounded-2xl border border-white/10 bg-black/25 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Top setup</p>
          <p className="mt-1 text-2xl font-black">{alert.symbol.replace("USDT", "")} <span className={sideClass(alert.side)}>{alert.side}</span></p>
        </div>
        <div className="text-right"><p className="text-sm text-slate-400">Score</p><p className="text-3xl font-black text-profit">{alert.score}</p></div>
      </div>
      <button onClick={onNotify} className="mt-4 w-full rounded-xl bg-profit px-4 py-3 text-sm font-black text-black transition hover:brightness-110">Відправити найкращий сигнал у Telegram</button>
    </div>
  );
}

function Metric({ label, value, accent = "text-white" }: { label: string; value: string; accent?: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[.045] p-4"><p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p><p className={`mt-2 text-xl font-black ${accent}`}>{value}</p></div>;
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[.04] p-4 text-center"><p className="text-xs uppercase tracking-[0.25em] text-slate-500">{label}</p><p className="mt-2 text-3xl font-black">{value}</p></div>;
}

function Row({ label, value, color = "text-slate-100" }: { label: string; value: string; color?: string }) {
  return <div className="rounded-2xl border border-white/10 bg-black/20 p-3"><p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</p><p className={`mt-1 break-words text-sm font-bold ${color}`}>{value}</p></div>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`rounded-full border px-4 py-2 text-sm font-bold transition ${active ? "border-cyan-300 bg-cyan-300/10 text-cyan-100" : "border-white/10 text-slate-400 hover:border-white/30 hover:text-white"}`}>{children}</button>;
}

function fmt(value: number) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(8);
}

function sideClass(side: Alert["side"]) {
  if (side === "LONG") return "text-profit";
  if (side === "SHORT") return "text-danger";
  return "text-warning";
}

function fearColor(value: number) {
  if (value < 30) return "text-danger";
  if (value < 55) return "text-warning";
  return "text-profit";
}
