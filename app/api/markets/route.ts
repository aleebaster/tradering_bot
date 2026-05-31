import { marketRegistry } from "@/src/local/marketRegistry";

export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";

export async function GET() {
  try {
    const registry = await marketRegistry();
    return Response.json({ ok: true, ...registry });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Market registry unavailable" }, { status: 502 });
  }
}
