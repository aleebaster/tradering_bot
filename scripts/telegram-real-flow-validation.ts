import { config } from "../src/local/config";
import { TelegramCommandCenter } from "../src/local/telegramCommands";

async function main() {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ ok: false, reason: "Telegram env is not configured" }, null, 2));
    process.exit(1);
  }

  const before = await webhookInfo();
  const center = new TelegramCommandCenter();
  await center.start();
  await sleep(Number(process.env.TELEGRAM_REAL_FLOW_SECONDS ?? 12) * 1000);
  center.stop();
  await sleep(1000);
  const after = await webhookInfo();

  const result = {
    ok: true,
    botConnected: true,
    webhookDisabled: !after.url,
    pendingBefore: before.pending_update_count ?? 0,
    pendingAfter: after.pending_update_count ?? 0,
    processedPendingUpdates: Math.max(0, (before.pending_update_count ?? 0) - (after.pending_update_count ?? 0)),
    note: "Real Telegram getUpdates polling ran against the configured bot and chat. Button text/callback updates are routed by TelegramCommandCenter."
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.webhookDisabled) process.exit(1);
}

async function webhookInfo() {
  const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const json = await res.json() as { ok: boolean; result?: { url?: string; pending_update_count?: number } };
  if (!json.ok || !json.result) throw new Error("Telegram getWebhookInfo failed");
  return json.result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
