import dotenv from "dotenv";
import { z } from "zod";
import type { Mode } from "./types";

dotenv.config();

const schema = z.object({
  BYBIT_API_KEY: z.string().optional(),
  BYBIT_API_SECRET: z.string().optional(),
  OKX_API_KEY: z.string().optional(),
  OKX_API_SECRET: z.string().optional(),
  OKX_PASSPHRASE: z.string().optional(),
  KUCOIN_API_KEY: z.string().optional(),
  KUCOIN_API_SECRET: z.string().optional(),
  KUCOIN_API_PASSPHRASE: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOCAL_API_PORT: z.coerce.number().default(4000),
  SCAN_INTERVAL_SECONDS: z.coerce.number().min(10).max(15).default(12),
  BOT_MODE: z.enum(["LOCAL_ONLY", "HYBRID", "OFFLINE_TEST"]).optional()
});

const env = schema.parse(process.env);
const partialMode = !env.OKX_PASSPHRASE;
const mode: Mode = env.BOT_MODE ?? "LOCAL_ONLY";

export const config = {
  ...env,
  mode,
  partialMode,
  warning: partialMode ? "Парольна фраза OKX відсутня — режим часткового підтвердження." : null,
  symbols: ["BTCUSDT", "ETHUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"],
  futuresTimeframes: ["5", "15", "60"],
  spotTimeframes: ["60", "240", "D"],
  maxSignalsPerDay: 5
};
