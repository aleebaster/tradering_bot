import dotenv from "dotenv";
import { z } from "zod";
import type { Mode } from "./types";

dotenv.config();

const schema = z.object({
  BYBIT_API_KEY: z.string().optional(),
  BYBIT_API_SECRET: z.string().optional(),
  OKX_API_KEY: z.string().optional(),
  OKX_API_SECRET: z.string().optional(),
  OKX_API_PASSPHRASE: z.string().optional(),
  OKX_SECRET_KEY: z.string().optional(),
  OKX_SECRET: z.string().optional(),
  OKX_PASSPHRASE: z.string().optional(),
  KUCOIN_API_KEY: z.string().optional(),
  KUCOIN_API_SECRET: z.string().optional(),
  KUCOIN_API_PASSPHRASE: z.string().optional(),
  KRAKEN_SPOT_API_KEY: z.string().optional(),
  KRAKEN_SPOT_API_SECRET: z.string().optional(),
  KRAKEN_FUTURES_API_KEY: z.string().optional(),
  KRAKEN_FUTURES_API_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  USER_BALANCE_USDT: z.coerce.number().positive().default(5),
  SMALL_BALANCE_GROWTH_MODE: z.string().optional(),
  HIGH_IMPACT_NEWS_BLOCK_UNTIL: z.string().optional(),
  LOCAL_API_PORT: z.coerce.number().default(4000),
  SCAN_INTERVAL_SECONDS: z.coerce.number().min(10).max(15).default(12),
  BOT_MODE: z.enum(["LOCAL_ONLY", "HYBRID", "OFFLINE_TEST"]).optional()
});

const parsed = schema.parse(process.env);
const env = {
  ...parsed,
  OKX_API_KEY: cleanSecret(parsed.OKX_API_KEY),
  OKX_API_SECRET: cleanSecret(parsed.OKX_SECRET_KEY ?? parsed.OKX_API_SECRET ?? parsed.OKX_SECRET),
  OKX_API_PASSPHRASE: cleanSecret(parsed.OKX_PASSPHRASE ?? parsed.OKX_API_PASSPHRASE),
  KUCOIN_API_KEY: cleanSecret(parsed.KUCOIN_API_KEY),
  KUCOIN_API_SECRET: cleanSecret(parsed.KUCOIN_API_SECRET),
  KUCOIN_API_PASSPHRASE: cleanSecret(parsed.KUCOIN_API_PASSPHRASE)
};
const partialMode = !env.OKX_API_KEY || !env.OKX_API_SECRET || !env.OKX_API_PASSPHRASE;
const mode: Mode = env.BOT_MODE ?? "LOCAL_ONLY";

export const config = {
  ...env,
  mode,
  partialMode,
  smallBalanceGrowthMode: env.SMALL_BALANCE_GROWTH_MODE !== "0",
  warning: partialMode ? "Парольна фраза OKX відсутня — режим часткового підтвердження." : null,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "AIGENSYNUSDT"],
  futuresTimeframes: ["1", "3", "5", "15", "60"],
  spotTimeframes: ["60", "240", "D"],
  maxSignalsPerDay: env.SMALL_BALANCE_GROWTH_MODE === "0" ? 5 : 2,
  minSignalCooldownMinutes: env.SMALL_BALANCE_GROWTH_MODE === "0" ? 20 : 45
};

function cleanSecret(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, "");
}
