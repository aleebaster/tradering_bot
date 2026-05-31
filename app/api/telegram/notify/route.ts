export const dynamic = "force-dynamic";

type Body = {
  symbol?: string;
  side?: string;
  score?: number;
  probability?: number;
  entry?: [number, number];
  stopLoss?: number;
  takeProfit?: [number, number, number];
  leverage?: string;
  reasons?: string[];
};

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID не налаштовані" }, { status: 400 });

  const body = (await request.json()) as Body;
  if (!body.symbol || !body.side) return Response.json({ ok: false, error: "symbol і side обов'язкові" }, { status: 422 });

  const text = [
    "🤖 OPENCODE BOT",
    "",
    "🔔 СПОВІЩЕННЯ З САЙТУ",
    "",
    `${body.side} — ${body.symbol}`,
    `Score: ${body.score ?? "-"}/100 · Ймовірність: ${body.probability ?? "-"}%`,
    body.entry ? `Вхід: ${fmt(body.entry[0])}–${fmt(body.entry[1])}` : null,
    body.stopLoss ? `SL: ${fmt(body.stopLoss)}` : null,
    body.takeProfit ? `TP: ${body.takeProfit.map(fmt).join(" / ")}` : null,
    body.leverage ? `Плече: ${body.leverage}` : null,
    "",
    ...(body.reasons ?? []).slice(0, 5).map((reason) => `• ${reason}`)
  ].filter(Boolean).join("\n");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) return Response.json({ ok: false, error: (await res.text()).slice(0, 200) }, { status: 502 });
  return Response.json({ ok: true });
}

function fmt(value: number) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(8);
}
