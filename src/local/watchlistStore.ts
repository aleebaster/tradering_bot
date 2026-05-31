import fs from "node:fs";
import path from "node:path";

const filePath = path.resolve(process.cwd(), "data", "priority-watchlist.json");

export interface PriorityWatchlistFile {
  pairs: string[];
  updatedAt: string;
}

export function loadPriorityWatchlist(): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PriorityWatchlistFile>;
    return Array.isArray(parsed.pairs) ? parsed.pairs.map(normalizePair).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function savePriorityWatchlist(pairs: string[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const unique = [...new Set(pairs.map(normalizePair).filter(Boolean))];
  fs.writeFileSync(filePath, JSON.stringify({ pairs: unique, updatedAt: new Date().toISOString() }, null, 2));
  return unique;
}

export function addPriorityPair(pair: string) {
  const pairs = loadPriorityWatchlist();
  const normalized = normalizePair(pair);
  if (!normalized) return pairs;
  return savePriorityWatchlist([...pairs, normalized]);
}

export function removePriorityPair(pair: string) {
  const normalized = normalizePair(pair);
  if (!normalized) return loadPriorityWatchlist();
  return savePriorityWatchlist(loadPriorityWatchlist().filter((item) => item !== normalized));
}

export function normalizePriorityPair(pair: string) {
  return normalizePair(pair);
}

function normalizePair(pair: string) {
  return pair.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
