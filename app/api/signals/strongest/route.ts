import { localState, unavailable } from "@/lib/localApi";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await localState();
  if (!state) return unavailable();
  return Response.json([...state.activeSignals, ...state.watchlist, ...state.history]
    .filter((signal: any) => setupBucket(signal.score) !== "ignore")
    .sort((a: any, b: any) => bucketRank(b.score) - bucketRank(a.score) || b.score - a.score)
    .slice(0, 10));
}

function setupBucket(score: number) {
  if (score < 40) return "ignore";
  if (score < 60) return "weak";
  if (score < 75) return "possible";
  if (score < 85) return "strong";
  return "entry";
}

function bucketRank(score: number) {
  const bucket = setupBucket(score);
  if (bucket === "entry") return 5;
  if (bucket === "strong") return 4;
  if (bucket === "possible") return 3;
  if (bucket === "weak") return 2;
  return 0;
}
