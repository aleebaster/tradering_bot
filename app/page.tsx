"use client";

import { useEffect, useState } from "react";

type Side = "LONG" | "SHORT" | "BUY" | "NO_TRADE" | "WATCHLIST";
type Signal = {
  id: string;
  createdAt: string;
  symbol: string;
  mode: "spot" | "futures";
  side: Side;
  score: number;
  winProbability: number;
  confidence: number;
  currentPrice: number;
  entryStatus: "ENTER_NOW" | "WAIT_FOR_ENTRY" | "NO_TRADE";
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage?: string;
  riskReward: string;
  invalidationLevel: number;
  holdTime: string;
  marketRegime: string;
  btcStable: boolean;
  reasons: string[];
  rejectionReason: string;
  tradeManagementActions: string[];
  management: string;
};
type BotState = {
  diagnostics: { startedAt: string; lastScanAt: string | null; mode: string; partialMode: boolean; warnings: string[]; scannedSymbols: number; apiStatus: Record<string, string> };
  marketCondition: string;
  activeSignals: Signal[];
  watchlist: Signal[];
  history: Signal[];
  stats: { signalsToday: number; wins: number; losses: number; winRate: number };
};

const apiUrl = (process.env.NEXT_PUBLIC_LOCAL_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
type ConnectionMode = "connecting" | "local" | "engine-required" | "remote";

export default function Dashboard() {
  const [state, setState] = useState<BotState | null>(null);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("connecting");
  const [diagnostic, setDiagnostic] = useState("Перевіряю підключення до локального рушія...");

  useEffect(() => {
    let alive = true;
    const hostedOnVercel = !["localhost", "127.0.0.1"].includes(window.location.hostname);
    const apiIsLocal = apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1");
    if (hostedOnVercel && apiIsLocal) {
      setConnectionMode("engine-required");
      setDiagnostic("Vercel-панель не може напряму керувати локальним Windows-рушієм через localhost. Запустіть бекенд на Windows або налаштуйте доступний HTTPS API/тунель у NEXT_PUBLIC_LOCAL_API_URL.");
      return () => { alive = false; };
    }
    async function load() {
      try {
        const res = await fetch(`${apiUrl}/state`, { cache: "no-store" });
        if (!res.ok) throw new Error("Локальний API недоступний");
        const next = (await res.json()) as BotState;
        if (alive) { setState(next); setConnectionMode(apiIsLocal ? "local" : "remote"); setDiagnostic("Локальний рушій підключено і передає live-дані."); }
      } catch (error) {
        if (alive) { setConnectionMode("engine-required"); setDiagnostic(error instanceof Error ? error.message : "Локальний рушій недоступний"); }
      }
    }
    void load();
    const wsUrl = apiUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setConnectionMode(apiIsLocal ? "local" : "remote");
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; state: BotState };
      if (payload.type === "state") setState(payload.state);
    };
    ws.onerror = () => { setConnectionMode("engine-required"); setDiagnostic("WebSocket локального рушія недоступний. Сканер має працювати на Windows-хості."); };
    const interval = setInterval(load, 15000);
    return () => { alive = false; ws.close(); clearInterval(interval); };
  }, []);

  const active = state?.activeSignals ?? [];
  const watchlist = state?.watchlist ?? [];
  const history = state?.history ?? [];
  const strongest = [...active, ...watchlist, ...history].sort((a, b) => b.score - a.score).slice(0, 5);

  return (
    <main className="min-h-screen px-4 py-5 md:px-8">
      <header className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Локальний ШІ-термінал сигналів</p>
          <h1 className="mt-2 text-3xl font-black md:text-5xl">Командний центр криптосигналів</h1>
        </div>
        <div className={`rounded-full border px-4 py-2 text-sm ${connectionMode === "local" || connectionMode === "remote" ? "border-profit/50 text-profit" : connectionMode === "engine-required" ? "border-warning/50 text-warning" : "border-edge text-slate-300"}`}>
          {connectionTitle(connectionMode)}
        </div>
      </header>

      <section className="mb-6 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-slate-100">
        <p className="font-bold text-warning">{connectionMode === "engine-required" ? "⚠️ ЛОКАЛЬНИЙ РУШІЙ ПОТРІБЕН" : "🟡 ЛОКАЛЬНИЙ РЕЖИМ"}</p>
        <p className="mt-2">{diagnostic}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <Row label="Бекенд" value={connectionMode === "local" || connectionMode === "remote" ? "Підключено локально" : "Очікує локальний Windows API"} />
          <Row label="Сканер" value={connectionMode === "local" || connectionMode === "remote" ? "Працює на Windows-хості" : "Запустіть START_BOT.bat"} />
          <Row label="Сигнальний рушій" value={connectionMode === "local" || connectionMode === "remote" ? "Активний" : "Працює лише локально"} />
          <Row label="Біржі" value={state ? "Статус нижче у діагностиці" : "Потрібен локальний backend"} />
        </div>
      </section>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <Metric label="Стан ринку" value={state?.marketCondition ?? "Очікування локального сканера"} wide />
        <Metric label="Сигналів сьогодні" value={String(state?.stats.signalsToday ?? 0)} />
        <Metric label="Режим сканера" value={modeUa(state?.diagnostics.mode ?? "LOCAL_ONLY")} />
        <Metric label="Останнє сканування" value={state?.diagnostics.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "Очікується"} />
      </section>

      {state?.diagnostics.warnings.map((w) => <div key={w} className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-warning">{w}</div>)}

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Panel title="Найсильніші сетапи">
          <div className="grid gap-3">
            {strongest.length ? strongest.map((s) => <SignalCard key={s.id} signal={s} />) : <Empty text="Сетапів з високою ймовірністю поки немає. Сканер відсіює слабкий ринок." />}
          </div>
        </Panel>
        <Panel title="Діагностика">
          <div className="space-y-3">
            {Object.entries(state?.diagnostics.apiStatus ?? {}).map(([k, v]) => <Row key={k} label={k.toUpperCase()} value={v} />)}
            <Row label="Проскановано символів" value={String(state?.diagnostics.scannedSymbols ?? 0)} />
            <Row label="Локальний API" value={apiUrl} />
          </div>
        </Panel>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Ф'ючерсні сигнали"><SignalList items={active.filter((s) => s.mode === "futures")} /></Panel>
        <Panel title="Спотові сигнали"><SignalList items={active.filter((s) => s.mode === "spot")} /></Panel>
        <Panel title="Спостереження"><SignalList items={watchlist.slice(0, 8)} /></Panel>
      </section>

      <Panel title="Історія сигналів" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="text-slate-400"><tr><th>Час</th><th>Символ</th><th>Режим</th><th>Напрям</th><th>Оцінка</th><th>Ймовірність</th><th>Ринок</th><th>Управління</th></tr></thead>
            <tbody>{history.slice(0, 30).map((s) => <tr key={s.id} className="border-t border-edge/70"><td className="py-3">{new Date(s.createdAt).toLocaleTimeString()}</td><td>{s.symbol}</td><td>{modeUa(s.mode)}</td><td className={sideClass(s.side)}>{sideUa(s.side)}</td><td>{s.score}</td><td>{s.winProbability}%</td><td>{regimeUa(s.marketRegime)}</td><td>{s.management}</td></tr>)}</tbody>
          </table>
        </div>
      </Panel>
    </main>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return <section className={`glass rounded-2xl p-4 ${className}`}><h2 className="mb-4 text-lg font-bold">{title}</h2>{children}</section>;
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`glass rounded-2xl p-4 ${wide ? "md:col-span-1" : ""}`}><p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p><p className="mt-2 text-lg font-bold text-white">{value}</p></div>;
}

function SignalCard({ signal }: { signal: Signal }) {
  return (
    <article className="rounded-xl border border-edge bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-black">{signal.symbol} <span className={sideClass(signal.side)}>{sideUa(signal.side)}</span></h3><div className="rounded-full bg-profit/10 px-3 py-1 text-profit">Ймовірність успіху: {signal.winProbability}%</div></div>
      <div className="mt-3 grid gap-2 text-sm md:grid-cols-4"><Row label="Статус" value={entryStatusUa(signal.entryStatus)} /><Row label="Зона входу" value={`${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`} /><Row label="Поточна ціна" value={fmt(signal.currentPrice)} /><Row label="Плече" value={signal.leverage ?? "Немає"} /><Row label="Стоп-лосс" value={fmt(signal.stopLoss)} /><Row label="TP" value={signal.takeProfit.map(fmt).join(" / ")} /><Row label="Ризик/прибуток" value={signal.riskReward} /><Row label="Впевненість" value={`${signal.confidence}%`} /></div>
      <p className="mt-3 text-sm text-slate-300">{signal.side === "NO_TRADE" ? signal.rejectionReason : signal.reasons.join(". ")}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">{signal.tradeManagementActions?.slice(0, 4).map((action) => <span key={action} className="rounded-full border border-edge px-2 py-1">{action}</span>)}</div>
    </article>
  );
}

function SignalList({ items }: { items: Signal[] }) {
  if (!items.length) return <Empty text="Активних якісних сигналів немає." />;
  return <div className="space-y-3">{items.map((s) => <div key={s.id} className="rounded-xl border border-edge p-3"><div className="flex justify-between"><b>{s.symbol}</b><span className={sideClass(s.side)}>{sideUa(s.side)}</span></div><div className="mt-2 text-sm text-slate-400">Оцінка {s.score}/100 · {entryStatusUa(s.entryStatus)} · {s.leverage ?? "Немає"}</div></div>)}</div>;
}

function Row({ label, value }: { label: string; value: string }) { return <div><p className="text-xs uppercase text-slate-500">{label}</p><p className="break-words text-sm text-slate-100">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-edge p-4 text-slate-400">{text}</p>; }
function fmt(n: number) { return n >= 100 ? n.toFixed(2) : n.toFixed(5); }
function sideClass(side: Side) { return side === "LONG" || side === "BUY" ? "text-profit" : side === "SHORT" ? "text-danger" : side === "WATCHLIST" ? "text-warning" : "text-slate-500"; }
function connectionTitle(mode: ConnectionMode) { return mode === "local" || mode === "remote" ? "🟡 ЛОКАЛЬНИЙ РЕЖИМ" : mode === "engine-required" ? "⚠️ ЛОКАЛЬНИЙ РУШІЙ ПОТРІБЕН" : "ПЕРЕВІРКА ПІДКЛЮЧЕННЯ"; }
function sideUa(side: Side) { return side === "NO_TRADE" ? "НЕ ВХОДИТИ" : side === "WATCHLIST" ? "СПОСТЕРЕЖЕННЯ" : side; }
function entryStatusUa(status: Signal["entryStatus"]) { return status === "ENTER_NOW" ? "ЗАХОДИТИ ЗАРАЗ" : status === "WAIT_FOR_ENTRY" ? "ЧЕКАТИ ЗОНУ ВХОДУ" : "НЕ ВХОДИТИ"; }
function modeUa(mode: string) { return mode === "futures" ? "ф'ючерси" : mode === "spot" ? "спот" : mode === "LOCAL_ONLY" ? "локальний" : mode; }
function regimeUa(regime: string) { return ({ TRENDING: "трендовий", RANGING: "боковий", VOLATILE: "волатильний", NEWS_DRIVEN: "новинний", MANIPULATION_RISK: "ризик маніпуляції" } as Record<string, string>)[regime] ?? regime; }
