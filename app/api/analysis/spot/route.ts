import { analyzeSpot } from "@/src/local/spotAnalysis";

export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) return Response.json({ ok: false, error: "q is required" }, { status: 422 });
  try {
    return Response.json({ ok: true, analysis: await analyzeSpot(q) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Spot analysis unavailable" }, { status: 502 });
  }
}
