import { spawn } from "node:child_process";
import { loadPriorityWatchlist } from "../src/local/watchlistStore";

const restartDelayMs = 10_000;
const children = new Map<string, ReturnType<typeof spawn>>();

function startPair(pair: string) {
  if (children.has(pair)) return;
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/manual-aigensyn-bybit.ts", pair], {
    cwd: process.cwd(),
    env: { ...process.env, PRIORITY_WATCH: "1", PAIR: pair },
    stdio: "inherit",
    windowsHide: false
  });
  children.set(pair, child);
  child.on("exit", (code) => {
    children.delete(pair);
    console.error(`Priority watcher ${pair} stopped with code ${code}; restarting in ${restartDelayMs / 1000}s`);
    setTimeout(() => startPair(pair), restartDelayMs);
  });
}

function syncWatchers() {
  const pairs = loadPriorityWatchlist();
  for (const pair of pairs) startPair(pair);
  for (const pair of children.keys()) {
    if (!pairs.includes(pair)) {
      children.get(pair)?.kill();
      children.delete(pair);
    }
  }
  if (!pairs.length) console.log("Priority watchlist empty; waiting for pairs");
}

syncWatchers();
setInterval(syncWatchers, 30_000);
