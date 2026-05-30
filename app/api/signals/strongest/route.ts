import { localState, unavailable } from "@/lib/localApi";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await localState();
  if (!state) return unavailable();
  return Response.json([...state.activeSignals, ...state.watchlist, ...state.history].sort((a: any, b: any) => b.score - a.score).slice(0, 10));
}
