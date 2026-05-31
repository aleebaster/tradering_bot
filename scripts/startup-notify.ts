import { loadPriorityWatchlist } from "../src/local/watchlistStore";

const pairs = loadPriorityWatchlist();

console.log(JSON.stringify({ ok: true, telegram: "silent_startup", pairs }, null, 2));
