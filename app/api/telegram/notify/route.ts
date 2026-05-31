export const dynamic = "force-dynamic";

type Body = {
  symbol?: string;
  side?: string;
  score?: number;
  confidence?: number;
  probability?: number;
  entry?: [number, number];
  stopLoss?: number;
  takeProfit?: [number, number, number];
  leverage?: string;
  reasons?: string[];
  realEntry?: boolean;
  sniperConfirmed?: boolean;
  priceInsideEntry?: boolean;
  btcStable?: boolean;
  liquidityOk?: boolean;
  volumeOk?: boolean;
  rrOk?: boolean;
  fakeBreakout?: boolean;
  manipulationRisk?: boolean;
};

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID не налаштовані" }, { status: 400 });

  const body = (await request.json()) as Body;
  if (!body.symbol || !body.side) return Response.json({ ok: false, error: "symbol і side обов'язкові" }, { status: 422 });
  if (!isAllowedRealEntry(body)) return Response.json({ ok: true, sent: false, reason: "suppressed_non_real_entry" });

  const text = [
    `🚨 SIGNAL: ${body.side?.toUpperCase()}`,
    "",
    "📍 Pair:",
    body.symbol.toUpperCase(),
    "",
    "🎯 Entry:",
    `${fmt(body.entry![0])}–${fmt(body.entry![1])}`,
    "",
    "🛡 Stop Loss:",
    fmt(body.stopLoss!),
    "",
    "💰 Take Profit:",
    `TP1 ${fmt(body.takeProfit![0])} / TP2 ${fmt(body.takeProfit![1])} / TP3 ${fmt(body.takeProfit![2])}`,
    "",
    "⚡ Leverage:",
    body.leverage,
    "",
    "📈 Confidence:",
    `${body.confidence ?? body.score}%`,
    "",
    "📊 Reason:",
    (body.reasons ?? ["RSI, MACD, SMA trend, sniper and volume confirmed."])[0]
  ].filter(Boolean).join("\n");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!res.ok) return Response.json({ ok: false, error: (await res.text()).slice(0, 200) }, { status: 502 });
  return Response.json({ ok: true });
}

function isAllowedRealEntry(body: Body) {
  return body.realEntry === true
    && (body.side?.toUpperCase() === "LONG" || body.side?.toUpperCase() === "SHORT")
    && (body.score ?? 0) >= 92
    && (body.confidence ?? body.score ?? 0) >= 90
    && Array.isArray(body.entry)
    && body.entry.length === 2
    && typeof body.stopLoss === "number"
    && Array.isArray(body.takeProfit)
    && body.takeProfit.length === 3
    && (body.leverage === "x2" || body.leverage === "x3")
    && body.sniperConfirmed === true
    && body.priceInsideEntry === true
    && body.btcStable === true
    && body.liquidityOk === true
    && body.volumeOk === true
    && body.rrOk === true
    && body.fakeBreakout !== true
    && body.manipulationRisk !== true;
}

function fmt(value: number) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(8);
}
