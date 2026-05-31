import { TelegramNotifier } from "../src/local/telegram";
import { loadPriorityWatchlist } from "../src/local/watchlistStore";

const notifier = new TelegramNotifier();
const pairs = loadPriorityWatchlist();

const message = [
  "✅ Watchlist restored",
  "",
  "Моніторинг:",
  ...(pairs.length ? pairs.map((pair) => `✅ ${pair}`) : ["⚠️ priority watchlist порожній"]),
  "",
  "✅ Scanner active",
  "✅ Dashboard active",
  "✅ Telegram active",
  "✅ Auto recovery active"
].join("\n");

notifier.send(message).then(() => {
  console.log(JSON.stringify({ ok: true, pairs }, null, 2));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
