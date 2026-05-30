import { localState, unavailable } from "@/lib/localApi";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await localState();
  if (!state) return unavailable();
  return Response.json(state.history.filter((s) => s.mode === "spot"));
}
