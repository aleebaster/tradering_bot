const localApiUrl = (process.env.NEXT_PUBLIC_LOCAL_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export async function localState() {
  const res = await fetch(`${localApiUrl}/state`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as {
    marketCondition: string;
    activeSignals: unknown[];
    watchlist: unknown[];
    history: Array<{ mode: string; score: number }>;
  };
}

export function unavailable() {
  return Response.json({ ok: false, error: "Local scanner API unavailable", localApiUrl }, { status: 503 });
}
