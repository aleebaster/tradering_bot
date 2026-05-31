import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

export type RiskMode = "Conservative" | "Balanced" | "Aggressive";
export type MaxLeverage = "x2" | "x3" | "x5";

export interface TelegramSettings {
  balanceUsdt: number;
  maxLeverage: MaxLeverage;
  notifications: boolean;
  riskMode: RiskMode;
  updatedAt: string;
}

const filePath = path.resolve(process.cwd(), "data", "telegram-settings.json");

export function loadTelegramSettings(): TelegramSettings {
  try {
    if (!fs.existsSync(filePath)) return defaultSettings();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TelegramSettings>;
    return {
      balanceUsdt: validBalance(parsed.balanceUsdt) ? parsed.balanceUsdt : config.USER_BALANCE_USDT,
      maxLeverage: parsed.maxLeverage === "x2" || parsed.maxLeverage === "x3" || parsed.maxLeverage === "x5" ? parsed.maxLeverage : "x5",
      notifications: typeof parsed.notifications === "boolean" ? parsed.notifications : true,
      riskMode: parsed.riskMode === "Conservative" || parsed.riskMode === "Balanced" || parsed.riskMode === "Aggressive" ? parsed.riskMode : "Conservative",
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return defaultSettings();
  }
}

export function updateTelegramSettings(patch: Partial<Omit<TelegramSettings, "updatedAt">>) {
  const next = { ...loadTelegramSettings(), ...patch, updatedAt: new Date().toISOString() };
  save(next);
  return next;
}

export function maxLeverageNumber() {
  const value = loadTelegramSettings().maxLeverage;
  return value === "x5" ? 5 : value === "x3" ? 3 : 2;
}

export function riskMultiplier() {
  const mode = loadTelegramSettings().riskMode;
  if (mode === "Aggressive") return 1.25;
  if (mode === "Balanced") return 1;
  return 0.75;
}

export function notificationsEnabled() {
  return loadTelegramSettings().notifications;
}

function save(settings: TelegramSettings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

function defaultSettings(): TelegramSettings {
  return { balanceUsdt: config.USER_BALANCE_USDT, maxLeverage: "x5", notifications: true, riskMode: "Conservative", updatedAt: new Date().toISOString() };
}

function validBalance(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
