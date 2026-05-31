import fs from "node:fs";
import path from "node:path";

const filePath = path.join(process.cwd(), "data", "loss-protection.json");

interface LossProtectionState {
  consecutiveSl: number;
  losses: string[];
  pauseUntil: string | null;
  updatedAt: string;
}

export function recordProtectionOutcome(outcome: "WIN" | "LOSS") {
  const state = loadLossProtection();
  if (outcome === "WIN") state.consecutiveSl = 0;
  else {
    state.consecutiveSl += 1;
    state.losses.unshift(new Date().toISOString());
    state.losses = state.losses.filter((item) => Date.now() - Date.parse(item) < 24 * 60 * 60_000).slice(0, 20);
    if (state.consecutiveSl >= 3) state.pauseUntil = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  }
  saveLossProtection(state);
  return state;
}

export function signalsPaused() {
  const state = loadLossProtection();
  return state.pauseUntil ? Date.parse(state.pauseUntil) > Date.now() : false;
}

export function conservativeModeActive() {
  return loadLossProtection().losses.filter((item) => Date.now() - Date.parse(item) < 24 * 60 * 60_000).length >= 5;
}

export function lossProtectionText() {
  const state = loadLossProtection();
  return [
    `SL streak: ${state.consecutiveSl}`,
    `24h losses: ${state.losses.length}`,
    `Pause: ${signalsPaused() ? `ON до ${state.pauseUntil}` : "OFF"}`,
    `Conservative: ${conservativeModeActive() ? "ON" : "OFF"}`
  ].join("\n");
}

function loadLossProtection(): LossProtectionState {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<LossProtectionState>;
    return { consecutiveSl: parsed.consecutiveSl ?? 0, losses: Array.isArray(parsed.losses) ? parsed.losses : [], pauseUntil: parsed.pauseUntil ?? null, updatedAt: parsed.updatedAt ?? new Date().toISOString() };
  } catch {
    return emptyState();
  }
}

function saveLossProtection(state: LossProtectionState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function emptyState(): LossProtectionState {
  return { consecutiveSl: 0, losses: [], pauseUntil: null, updatedAt: new Date().toISOString() };
}
