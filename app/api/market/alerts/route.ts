import { localState } from "@/lib/localApi";

export const dynamic = "force-dynamic";

type BinanceTicker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  count: number;
};

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];

type Alert = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT" | "WATCH";
  score: number;
  probability: number;
  price: number;
  change24h: number;
  volumeUsdt: number;
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage: string;
  riskReward: string;
  status: "ENTER_NOW" | "WAIT" | "WATCH";
  reasons: string[];
  heat: "hot" | "warm" | "cold";
  exchangeUrl: string;
  createdAt: string;
};

type EngineSignal = {
  id: string;
  createdAt: string;
  symbol: string;
  side: "LONG" | "SHORT" | "BUY" | "NO_TRADE" | "WATCHLIST";
  score: number;
  winProbability: number;
  confidence: number;
  currentPrice: number;
  entryStatus: "ENTER_NOW" | "WAIT_FOR_ENTRY" | "NO_TRADE";
  entry: [number, number];
  stopLoss: number;
  takeProfit: [number, number, number];
  leverage?: string;
  riskReward: string;
  reasons: string[];
  rejectionReason: string;
};

const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT", "SUIUSDT", "PEPEUSDT"];
const notified = new Map<string, number>();

export async function GET() {
  try {
    const [engineState, fearGreed] = await Promise.all([localState().catch(() => null), loadFearGreed()]);
    if (engineState) {
      const alerts = engineAlerts(engineState as unknown as { marketCondition?: string; activeSignals?: EngineSignal[]; watchlist?: EngineSignal[]; history?: EngineSignal[] });
      return Response.json({
        ok: true,
        source: "engine",
        generatedAt: new Date().toISOString(),
        fearGreed,
        marketPulse: engineState.marketCondition ?? summarizeMarket(alerts),
        stats: {
          scanned: alerts.length,
          enterNow: alerts.filter((alert) => alert.status === "ENTER_NOW").length,
          watch: alerts.filter((alert) => alert.status !== "ENTER_NOW").length,
          avgScore: Math.round(alerts.reduce((sum, alert) => sum + alert.score, 0) / Math.max(alerts.length, 1))
        },
        alerts
      });
    }

    const tickers = await loadTickers();
    const selected = tickers
      .filter((ticker) => symbols.includes(ticker.symbol))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 10);

    const alerts = (await Promise.all(selected.map(buildAlert))).filter(Boolean) as Alert[];
    alerts.sort((a, b) => b.score - a.score);

    const best = alerts.find((alert) => alert.status === "ENTER_NOW" && alert.score >= 86);
    if (best && process.env.AUTO_NOTIFY_TELEGRAM === "1") await notifyTelegram(best);

    return Response.json({
      ok: true,
      source: "public-market-fallback",
      generatedAt: new Date().toISOString(),
      fearGreed,
      marketPulse: summarizeMarket(alerts),
      stats: {
        scanned: selected.length,
        enterNow: alerts.filter((alert) => alert.status === "ENTER_NOW").length,
        watch: alerts.filter((alert) => alert.status !== "ENTER_NOW").length,
        avgScore: Math.round(alerts.reduce((sum, alert) => sum + alert.score, 0) / Math.max(alerts.length, 1))
      },
      alerts
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Market API unavailable" }, { status: 502 });
  }
}

function engineAlerts(state: { activeSignals?: EngineSignal[]; watchlist?: EngineSignal[]; history?: EngineSignal[] }) {
  const byId = new Map<string, EngineSignal>();
  for (const signal of [...(state.activeSignals ?? []), ...(state.watchlist ?? []), ...(state.history ?? [])]) {
    if (signal.side === "NO_TRADE") continue;
    if (!byId.has(signal.id)) byId.set(signal.id, signal);
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((signal) => {
      const side = signal.side === "SHORT" ? "SHORT" : signal.side === "WATCHLIST" ? "WATCH" : "LONG";
      const status = signal.side === "WATCHLIST" ? "WATCH" : signal.entryStatus === "ENTER_NOW" ? "ENTER_NOW" : "WAIT";
      return {
        id: signal.id,
        symbol: signal.symbol,
        side,
        score: signal.score,
        probability: signal.winProbability ?? signal.confidence ?? signal.score,
        price: signal.currentPrice,
        change24h: 0,
        volumeUsdt: 0,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        leverage: signal.leverage ?? (side === "WATCH" ? "без плеча" : "x2"),
        riskReward: signal.riskReward,
        status,
        reasons: signal.reasons?.length ? signal.reasons : [signal.rejectionReason || "Сигнал з primary trading bot engine"],
        heat: signal.score >= 86 ? "hot" : signal.score >= 80 ? "warm" : "cold",
        exchangeUrl: `https://www.bybit.com/trade/usdt/${signal.symbol}`,
        createdAt: signal.createdAt
      } satisfies Alert;
    });
}

async function loadTickers() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", { next: { revalidate: 20 } });
  if (!res.ok) throw new Error(`Binance ticker error ${res.status}`);
  return (await res.json()) as BinanceTicker[];
}

async function loadFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { next: { revalidate: 1800 } });
    if (!res.ok) throw new Error("FNG failed");
    const json = await res.json();
    return { value: Number(json.data?.[0]?.value ?? 50), label: String(json.data?.[0]?.value_classification ?? "Neutral") };
  } catch {
    return { value: 50, label: "Neutral" };
  }
}

async function buildAlert(ticker: BinanceTicker): Promise<Alert | null> {
  const candles = await loadKlines(ticker.symbol);
  if (candles.length < 60) return null;

  const closes = candles.map((candle) => Number(candle[4]));
  const highs = candles.map((candle) => Number(candle[2]));
  const lows = candles.map((candle) => Number(candle[3]));
  const price = Number(ticker.lastPrice);
  const change24h = Number(ticker.priceChangePercent);
  const volumeUsdt = Number(ticker.quoteVolume);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiValue = rsi(closes);
  const atrValue = atr(highs, lows, closes);
  const momentum = ((closes.at(-1)! - closes.at(-7)!) / closes.at(-7)!) * 100;
  const volumeScore = Math.min(100, Math.log10(Math.max(volumeUsdt, 1)) * 10);
  const trendUp = price > ema20 && ema20 > ema50;
  const trendDown = price < ema20 && ema20 < ema50;
  const side = trendUp ? "LONG" : trendDown ? "SHORT" : "WATCH";
  const direction = side === "SHORT" ? -1 : 1;
  const trendScore = side === "WATCH" ? 46 : Math.min(100, Math.abs(ema20 - ema50) / Math.max(atrValue, price * 0.001) * 24 + 55);
  const momentumScore = side === "SHORT" ? clamp(50 - momentum * 7) : clamp(50 + momentum * 7);
  const rsiScore = side === "SHORT" ? clamp(100 - Math.abs(rsiValue - 42) * 2.2) : clamp(100 - Math.abs(rsiValue - 58) * 2.2);
  const score = Math.round(clamp(trendScore * 0.38 + momentumScore * 0.26 + rsiScore * 0.18 + volumeScore * 0.18));
  const probability = Math.min(94, Math.max(51, score + (side === "WATCH" ? -7 : 4)));
  const entryOffset = Math.max(atrValue * 0.18, price * 0.0015);
  const stopDistance = Math.max(atrValue * 1.15, price * 0.008);
  const entry: [number, number] = side === "SHORT" ? [price - entryOffset * 0.25, price + entryOffset] : [price - entryOffset, price + entryOffset * 0.25];
  const averageEntry = (entry[0] + entry[1]) / 2;
  const stopLoss = averageEntry - stopDistance * direction;
  const takeProfit: [number, number, number] = [averageEntry + stopDistance * 1.25 * direction, averageEntry + stopDistance * 2 * direction, averageEntry + stopDistance * 3 * direction];
  const insideEntry = price >= Math.min(...entry) && price <= Math.max(...entry);
  const status = score >= 86 && side !== "WATCH" && insideEntry ? "ENTER_NOW" : score >= 78 && side !== "WATCH" ? "WAIT" : "WATCH";

  return {
    id: `${ticker.symbol}-${Date.now()}`,
    symbol: ticker.symbol,
    side,
    score,
    probability,
    price,
    change24h,
    volumeUsdt,
    entry,
    stopLoss,
    takeProfit,
    leverage: side === "WATCH" ? "без плеча" : score >= 90 ? "x3" : "x2",
    riskReward: "1:3.0",
    status,
    reasons: reasons({ side, trendUp, trendDown, rsiValue, momentum, volumeUsdt, score }),
    heat: score >= 86 ? "hot" : score >= 78 ? "warm" : "cold",
    exchangeUrl: `https://www.binance.com/en/trade/${ticker.symbol.replace("USDT", "")}_USDT`,
    createdAt: new Date().toISOString()
  };
}

async function loadKlines(symbol: string) {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=96`, { next: { revalidate: 20 } });
  if (!res.ok) throw new Error(`Binance klines error ${symbol}`);
  return (await res.json()) as BinanceKline[];
}

function summarizeMarket(alerts: Alert[]) {
  const long = alerts.filter((alert) => alert.side === "LONG").length;
  const short = alerts.filter((alert) => alert.side === "SHORT").length;
  const hot = alerts.filter((alert) => alert.heat === "hot").length;
  if (hot >= 2) return "Є кілька сильних сетапів, ринок активний";
  if (long > short) return "Перевага покупців, шукаємо лонг-сетапи";
  if (short > long) return "Перевага продавців, обережно з лонгами";
  return "Нейтральний режим, краще чекати підтвердження";
}

function reasons(input: { side: Alert["side"]; trendUp: boolean; trendDown: boolean; rsiValue: number; momentum: number; volumeUsdt: number; score: number }) {
  const list = [];
  if (input.trendUp) list.push("EMA20 вище EMA50, тренд підтримує LONG");
  if (input.trendDown) list.push("EMA20 нижче EMA50, тренд підтримує SHORT");
  if (input.side === "WATCH") list.push("Тренд ще не синхронізований, потрібне підтвердження");
  list.push(`RSI ${input.rsiValue.toFixed(1)} без екстремального перегріву`);
  list.push(`Імпульс 90 хв: ${input.momentum >= 0 ? "+" : ""}${input.momentum.toFixed(2)}%`);
  if (input.volumeUsdt > 250_000_000) list.push("Висока ліквідність, менший ризик прослизання");
  if (input.score >= 86) list.push("Сигнал проходить поріг для Telegram-сповіщення");
  return list.slice(0, 5);
}

function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  return values.reduce((prev, value, index) => index === 0 ? value : value * k + prev * (1 - k), values[0] ?? 0);
}

function rsi(values: number[], period = 14) {
  const slice = values.slice(-period - 1);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(highs: number[], lows: number[], closes: number[], period = 14) {
  const trs = highs.slice(-period).map((high, index) => {
    const realIndex = highs.length - period + index;
    const prevClose = closes[realIndex - 1] ?? closes[realIndex];
    return Math.max(high - lows[realIndex], Math.abs(high - prevClose), Math.abs(lows[realIndex] - prevClose));
  });
  return trs.reduce((sum, value) => sum + value, 0) / Math.max(trs.length, 1);
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

async function notifyTelegram(alert: Alert) {
  return;
}

function formatPrice(value: number) {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(8);
}
