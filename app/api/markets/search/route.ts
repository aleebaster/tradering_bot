import { resolvePair } from "@/src/local/marketRegistry";

export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) return Response.json({ ok: false, error: "q is required" }, { status: 422 });
  try {
    return Response.json({ ok: true, ...(await resolvePair(q)) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Pair search unavailable" }, { status: 502 });
  }
}
