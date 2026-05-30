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
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage?: string;
  invalidationLevel: number;
  holdTime: string;
  marketRegime: string;
  btcStable: boolean;
  reasons: string[];
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

export default function Dashboard() {
  const [state, setState] = useState<BotState | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`${apiUrl}/state`, { cache: "no-store" });
        if (!res.ok) throw new Error("Local API unavailable");
        const next = (await res.json()) as BotState;
        if (alive) { setState(next); setOnline(true); }
      } catch {
        if (alive) setOnline(false);
      }
    }
    void load();
    const wsUrl = apiUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setOnline(true);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; state: BotState };
      if (payload.type === "state") setState(payload.state);
    };
    ws.onerror = () => setOnline(false);
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
          <p className="text-sm uppercase tracking-[0.35em] text-slate-400">Local AI Signal Terminal</p>
          <h1 className="mt-2 text-3xl font-black md:text-5xl">Crypto Signal Command Center</h1>
        </div>
        <div className={`rounded-full border px-4 py-2 text-sm ${online ? "border-profit/50 text-profit" : "border-danger/50 text-danger"}`}>
          {online ? "LOCAL SCANNER ONLINE" : "LOCAL API OFFLINE"}
        </div>
      </header>

      <section className="mb-6 grid gap-4 md:grid-cols-4">
        <Metric label="Market Condition" value={state?.marketCondition ?? "Waiting for local scanner"} wide />
        <Metric label="Signals Today" value={String(state?.stats.signalsToday ?? 0)} />
        <Metric label="Scanner Mode" value={state?.diagnostics.mode ?? "LOCAL_ONLY"} />
        <Metric label="Last Scan" value={state?.diagnostics.lastScanAt ? new Date(state.diagnostics.lastScanAt).toLocaleTimeString() : "Pending"} />
      </section>

      {state?.diagnostics.warnings.map((w) => <div key={w} className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-warning">{w}</div>)}

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Panel title="Strongest Setups">
          <div className="grid gap-3">
            {strongest.length ? strongest.map((s) => <SignalCard key={s.id} signal={s} />) : <Empty text="No high-probability setup yet. The scanner is filtering weak markets." />}
          </div>
        </Panel>
        <Panel title="Diagnostics">
          <div className="space-y-3">
            {Object.entries(state?.diagnostics.apiStatus ?? {}).map(([k, v]) => <Row key={k} label={k.toUpperCase()} value={v} />)}
            <Row label="Scanned Symbols" value={String(state?.diagnostics.scannedSymbols ?? 0)} />
            <Row label="Local API" value={apiUrl} />
          </div>
        </Panel>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Futures Signals"><SignalList items={active.filter((s) => s.mode === "futures")} /></Panel>
        <Panel title="Spot Signals"><SignalList items={active.filter((s) => s.mode === "spot")} /></Panel>
        <Panel title="Watchlist"><SignalList items={watchlist.slice(0, 8)} /></Panel>
      </section>

      <Panel title="Signal History" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-sm">
            <thead className="text-slate-400"><tr><th>Time</th><th>Symbol</th><th>Mode</th><th>Side</th><th>Score</th><th>Win Probability</th><th>Regime</th><th>Management</th></tr></thead>
            <tbody>{history.slice(0, 30).map((s) => <tr key={s.id} className="border-t border-edge/70"><td className="py-3">{new Date(s.createdAt).toLocaleTimeString()}</td><td>{s.symbol}</td><td>{s.mode}</td><td className={sideClass(s.side)}>{s.side}</td><td>{s.score}</td><td>{s.winProbability}%</td><td>{s.marketRegime}</td><td>{s.management}</td></tr>)}</tbody>
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
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-black">{signal.symbol} <span className={sideClass(signal.side)}>{signal.side}</span></h3><div className="rounded-full bg-profit/10 px-3 py-1 text-profit">Win Probability: {signal.winProbability}%</div></div>
      <div className="mt-3 grid gap-2 text-sm md:grid-cols-4"><Row label="Entry" value={`${fmt(signal.entry[0])} - ${fmt(signal.entry[1])}`} /><Row label="SL" value={fmt(signal.stopLoss)} /><Row label="TP" value={signal.takeProfit.map(fmt).join(" / ")} /><Row label="Confidence" value={`${signal.confidence}%`} /></div>
      <p className="mt-3 text-sm text-slate-300">{signal.reasons.join(". ")}</p>
    </article>
  );
}

function SignalList({ items }: { items: Signal[] }) {
  if (!items.length) return <Empty text="No active qualified signal." />;
  return <div className="space-y-3">{items.map((s) => <div key={s.id} className="rounded-xl border border-edge p-3"><div className="flex justify-between"><b>{s.symbol}</b><span className={sideClass(s.side)}>{s.side}</span></div><div className="mt-2 text-sm text-slate-400">Score {s.score}/100 · {s.marketRegime}</div></div>)}</div>;
}

function Row({ label, value }: { label: string; value: string }) { return <div><p className="text-xs uppercase text-slate-500">{label}</p><p className="break-words text-sm text-slate-100">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-edge p-4 text-slate-400">{text}</p>; }
function fmt(n: number) { return n >= 100 ? n.toFixed(2) : n.toFixed(5); }
function sideClass(side: Side) { return side === "LONG" || side === "BUY" ? "text-profit" : side === "SHORT" ? "text-danger" : side === "WATCHLIST" ? "text-warning" : "text-slate-500"; }
