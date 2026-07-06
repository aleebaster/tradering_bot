import { config } from "../src/local/config";

type TelegramStatus = {
  enabled: boolean;
  running: boolean;
  polling: boolean;
  offset: number;
  startedAt: string | null;
  lastPollAt: string | null;
  lastUpdateAt: string | null;
  processedUpdates: number;
  handledCallbacks: number;
  handledMessages: number;
};

async function main() {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ ok: false, reason: "Telegram env is not configured" }, null, 2));
    process.exit(1);
  }

  const beforeWebhook = await webhookInfo();
  const beforeStatus = await telegramStatus().catch(() => null);
  if (!beforeStatus?.running) {
    console.log(JSON.stringify({
      ok: false,
      reason: `Persistent local API is not running on port ${config.LOCAL_API_PORT}`,
      requiredAction: "Start START_BOT.bat or RUN_LOCAL_API_LOOP.bat first, then rerun this validation. The validation intentionally does not start or stop Telegram polling."
    }, null, 2));
    process.exit(1);
  }
  const waitSeconds = Number(process.env.TELEGRAM_REAL_FLOW_SECONDS ?? 20);

  console.log(JSON.stringify({
    phase: "live_validation_waiting",
    instruction: "Press Telegram buttons now. This script does not poll Telegram itself; persistent local:api must handle updates.",
    waitSeconds,
    beforeStatus
  }, null, 2));

  await sleep(waitSeconds * 1000);

  const afterStatus = await telegramStatus();
  const afterWebhook = await webhookInfo();
  const processedDelta = afterStatus.processedUpdates - beforeStatus.processedUpdates;
  const callbackDelta = afterStatus.handledCallbacks - beforeStatus.handledCallbacks;
  const messageDelta = afterStatus.handledMessages - beforeStatus.handledMessages;
  const result = {
    ok: afterStatus.enabled && afterStatus.running && !afterWebhook.url && (processedDelta > 0 || process.env.TELEGRAM_ALLOW_IDLE_VALIDATION === "1"),
    persistentBotRunning: afterStatus.running,
    webhookDisabled: !afterWebhook.url,
    testDidNotStartTemporaryPoller: true,
    beforePendingUpdates: beforeWebhook.pending_update_count ?? 0,
    afterPendingUpdates: afterWebhook.pending_update_count ?? 0,
    processedDelta,
    callbackDelta,
    messageDelta,
    beforeStatus,
    afterStatus,
    note: "Persistent local:api TelegramCommandCenter remains alive after this script exits. If processedDelta is >0, live post-test button presses were handled by the persistent bot."
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  process.exit(0);
}

async function telegramStatus(): Promise<TelegramStatus> {
  const res = await fetch(`http://localhost:${config.LOCAL_API_PORT}/telegram/status`);
  if (!res.ok) throw new Error(`Local API /telegram/status failed: ${res.status}`);
  return await res.json() as TelegramStatus;
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
