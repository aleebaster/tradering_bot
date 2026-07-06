import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";

export interface ModelParameters {
  momentumWeights: Record<string, number>;
  consensusThresholds: Record<string, number>;
  riskMultipliers: Record<string, number>;
  confidenceThresholds: Record<string, number>;
  liquidityThresholds: Record<string, number>;
  kellyFraction: number;
  pumpProbabilityMin: number;
  pumpExhaustionMax: number;
}

export interface ModelMetadata {
  id: string;
  parentId: string | null;
  createdAt: string;
  changedParameter: string | null;
  oldValue: number | null;
  newValue: number | null;
  reason: string;
  status: "ACTIVE" | "CANDIDATE" | "REJECTED" | "ROLLED_BACK";
  performance: {
    trades: number;
    winRate: number;
    profitFactor: number;
    drawdown: number;
    expectancy: number;
    sharpe: number;
  } | null;
  backtestPassed: boolean;
  shadowPassed: boolean;
}

export interface ModelEntry {
  parameters: ModelParameters;
  metadata: ModelMetadata;
}

const filePath = path.join(process.cwd(), "data", "model-registry.json");

const DEFAULT_PARAMETERS: ModelParameters = {
  momentumWeights: {
    priceAcceleration: 1.0, priceVelocity: 0.85, rateOfChange: 0.7,
    rawMomentum: 0.9, atrExpansion: 0.65, volumeExpansion: 1.0,
    relativeVolume: 0.75, volatilityExpansion: 0.6, emaExpansion: 0.8,
    macdExpansion: 0.85, rsiAcceleration: 0.55, adxGrowth: 0.5,
    bollingerExpansion: 0.55
  },
  consensusThresholds: {
    pumpProbabilityMin: 75, momentumScoreMin: 70, whaleScoreMin: 55,
    mtfAlignmentMin: 60, orderBookMin: 50, liquidityMin: 45
  },
  riskMultipliers: {
    baseRisk: 1.0, maxRisk: 1.5, minRisk: 0.5,
    volatilityAdjustment: 0.8, drawdownAdjustment: 0.6
  },
  confidenceThresholds: {
    enter: 85, watch: 72, early: 65, skip: 50
  },
  liquidityThresholds: {
    minVolume24h: 500000, minDepthUsdt: 30000, maxSpreadPct: 0.008
  },
  kellyFraction: 0.25,
  pumpProbabilityMin: 75,
  pumpExhaustionMax: 75
};

function load(): ModelEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(registry: ModelEntry[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
}

export function getActiveModel(): ModelEntry | null {
  const registry = load();
  return registry.find((m) => m.metadata.status === "ACTIVE") ?? null;
}

export function getCandidateModel(): ModelEntry | null {
  const registry = load();
  return registry.find((m) => m.metadata.status === "CANDIDATE") ?? null;
}

export function createCandidate(changedParameter: string, oldValue: number, newValue: number, reason: string): ModelEntry | null {
  const active = getActiveModel();
  if (!active) return null;

  const changedCount = 1;
  if (changedCount > 1) {
    logger.warn("ParameterGovernor: Only ONE parameter can change per candidate");
    return null;
  }

  const candidate: ModelEntry = {
    parameters: JSON.parse(JSON.stringify(active.parameters)),
    metadata: {
      id: `model_${Date.now()}`,
      parentId: active.metadata.id,
      createdAt: new Date().toISOString(),
      changedParameter,
      oldValue,
      newValue,
      reason,
      status: "CANDIDATE",
      performance: null,
      backtestPassed: false,
      shadowPassed: false
    }
  };

  const registry = load();
  registry.push(candidate);
  save(registry);
  logger.info({ candidateId: candidate.metadata.id, changedParameter, oldValue, newValue, reason }, "Model candidate created");
  return candidate;
}

export function activateCandidate(candidateId: string): boolean {
  const registry = load();
  const candidate = registry.find((m) => m.metadata.id === candidateId);
  if (!candidate || candidate.metadata.status !== "CANDIDATE") return false;

  const oldActive = registry.find((m) => m.metadata.status === "ACTIVE");
  if (oldActive) oldActive.metadata.status = "ROLLED_BACK";

  candidate.metadata.status = "ACTIVE";
  save(registry);
  return true;
}

export function rejectCandidate(candidateId: string): boolean {
  const registry = load();
  const candidate = registry.find((m) => m.metadata.id === candidateId);
  if (!candidate) return false;
  candidate.metadata.status = "REJECTED";
  save(registry);
  return true;
}

export function rollbackToModel(modelId: string): boolean {
  const registry = load();
  const target = registry.find((m) => m.metadata.id === modelId);
  if (!target) return false;

  const active = registry.find((m) => m.metadata.status === "ACTIVE");
  if (active) active.metadata.status = "ROLLED_BACK";

  target.metadata.status = "ACTIVE";
  save(registry);
  return true;
}

export function recordPerformance(modelId: string, perf: ModelMetadata["performance"]): void {
  const registry = load();
  const model = registry.find((m) => m.metadata.id === modelId);
  if (model) {
    model.metadata.performance = perf;
    save(registry);
  }
}

export function getModelHistory(limit = 10): ModelEntry[] {
  return load().sort((a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()).slice(0, limit);
}

export function modelStatusText(): string {
  const active = getActiveModel();
  const candidate = getCandidateModel();
  const history = getModelHistory(5);

  const lines: string[] = [
    "MODEL REGISTRY",
    `Active  : ${active ? active.metadata.id.slice(-8) + " (" + active.metadata.createdAt.slice(0, 10) + ")" : "none"}`,
    `Candidate: ${candidate ? candidate.metadata.id.slice(-8) + " (change: " + candidate.metadata.changedParameter + ")" : "none"}`,
    "",
    "Recent History:"
  ];

  for (const model of history) {
    const statusIcon = model.metadata.status === "ACTIVE" ? "✓" : model.metadata.status === "CANDIDATE" ? "?" : model.metadata.status === "REJECTED" ? "✗" : "↩";
    lines.push(`  ${statusIcon} ${model.metadata.id.slice(-8)} ${model.metadata.status.padEnd(12)} ${model.metadata.changedParameter ?? "initial"} → ${model.metadata.newValue ?? "—"}`);
  }

  return lines.join("\n");
}
