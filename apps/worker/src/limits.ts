import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { BudgetPolicy } from "@platform/core";
import type { EventStore } from "@platform/storage";

// Operator levers (ticket 033), engine-enforced: kill switches (global and
// per agent/alias), platform budget caps that CEILING every run's budget,
// and a rate limit derived from the event log itself. The config file is
// re-read on every check (mtime cache), so flipping a switch is editing the
// mounted file — seconds, not deploys.

const budgetSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallMs: z.number().int().positive().optional(),
  })
  .strict();

export const limitsConfigSchema = z
  .object({
    killSwitches: z
      .object({
        global: z.boolean().default(false),
        agents: z.record(z.boolean()).default({}),
      })
      .strict()
      .default({ global: false, agents: {} }),
    budgetCaps: budgetSchema.optional(),
    rateLimits: z
      .object({ runsPerHourPerAgent: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

export type LimitsConfig = z.infer<typeof limitsConfigSchema>;

export const NO_LIMITS: LimitsConfig = { killSwitches: { global: false, agents: {} } };

/** File loader with an mtime cache: cheap per-step checks, instant flips. */
export function makeLimitsLoader(configPath: string | undefined) {
  let cached: { mtimeMs: number; config: LimitsConfig } | null = null;
  return async function loadLimits(): Promise<LimitsConfig> {
    if (!configPath) return NO_LIMITS;
    const { mtimeMs } = await stat(configPath);
    if (cached !== null && cached.mtimeMs === mtimeMs) return cached.config;
    const parsed = limitsConfigSchema.safeParse(JSON.parse(await readFile(configPath, "utf8")));
    if (!parsed.success) {
      throw new Error(
        `LIMITS_CONFIG rejected: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    cached = { mtimeMs, config: parsed.data };
    return parsed.data;
  };
}

/** Field-wise min: a run requesting more than the cap silently gets the cap. */
export function capBudget(runBudget: BudgetPolicy, cap: BudgetPolicy | undefined): BudgetPolicy {
  if (cap === undefined) return runBudget;
  const fields = ["maxSteps", "maxTokens", "maxCostUsd", "maxWallMs"] as const;
  const merged: BudgetPolicy = {};
  for (const field of fields) {
    const values = [runBudget[field], cap[field]].filter((v): v is number => v !== undefined);
    if (values.length > 0) merged[field] = Math.min(...values);
  }
  return merged;
}

export type SwitchCheck =
  | { tripped: false }
  | { tripped: true; detail: string };

export function checkKillSwitch(config: LimitsConfig, agent: string): SwitchCheck {
  if (config.killSwitches.global) {
    return { tripped: true, detail: "global kill switch is on" };
  }
  if (config.killSwitches.agents[agent] === true) {
    return { tripped: true, detail: `kill switch is on for ${agent}` };
  }
  return { tripped: false };
}

/**
 * Sliding window from the log itself: RunStarted events for this agent in
 * the last hour. No new state — the audit trail IS the rate counter.
 */
export async function countRecentStarts(
  store: EventStore,
  agent: string,
  nowMs: number,
): Promise<number> {
  const windowStart = nowMs - 60 * 60 * 1000;
  let count = 0;
  for (const summary of await store.listRuns()) {
    const loaded = await store.load(summary.runId);
    const first = loaded?.events[0];
    if (
      first !== undefined &&
      first.type === "RunStarted" &&
      first.agent === agent &&
      first.at >= windowStart
    ) {
      count += 1;
    }
  }
  return count;
}
