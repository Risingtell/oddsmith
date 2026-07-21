/**
 * Append-only JSON log of every execution Oddsmith runs — the source the
 * on-chain verifier and the positions view read back. Gitignored (.data/).
 * Not a database; a hackathon needs durable-enough, not distributed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionReport } from "./execute/run.js";

const FILE = ".data/executions.json";

function load(): Record<string, ExecutionReport> {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, ExecutionReport>;
  } catch {
    return {};
  }
}

export function saveExecution(report: ExecutionReport): void {
  const all = load();
  all[report.id] = report;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export function getExecution(id: string): ExecutionReport | null {
  return load()[id] ?? null;
}

export function listExecutions(): ExecutionReport[] {
  return Object.values(load()).sort((a, b) => a.at.localeCompare(b.at));
}

/** Sum of stake actually deployed live today (UTC) — feeds the daily risk cap. */
export function spentTodayUsd(): number {
  const today = new Date().toISOString().slice(0, 10);
  return listExecutions()
    .filter((r) => r.mode === "live" && r.filled && r.at.slice(0, 10) === today)
    .reduce((s, r) => s + (r.order?.amountUsd ?? 0), 0);
}
