import { ScheduleOverlapPolicy } from "@temporalio/client";
import type { Client, ScheduleDescription, ScheduleHandle } from "@temporalio/client";
import { TASK_QUEUE } from "./client.js";
import { agentRun } from "./workflows.js";
import type { AgentRunInput } from "./workflows.js";

// Thin schedules (ticket 010; architecture §3): recurring runs for read-only
// agents with the operational policies chosen EXPLICITLY — timezone pinning,
// skip-if-running overlap, and a deliberate catch-up decision.

export interface AgentScheduleSpec {
  scheduleId: string;
  /** Standard cron, evaluated in `timezone` — never server-local. */
  cron: string;
  /** IANA zone the cron is pinned to (e.g. "America/Chicago"). */
  timezone: string;
  /**
   * Run template: agent version + bound parameters. The per-occurrence runId
   * is NOT set here — Temporal appends the occurrence time to the workflowId
   * (`<scheduleId>-<occurrence ISO time>`), and the workflow adopts it as the
   * runId, so retried scheduler actions dedupe (workflowId = runId, ticket 003).
   */
  template: Omit<AgentRunInput, "runId">;
  /**
   * Explicit catch-up decision — REQUIRED, no accidental default:
   * 0 drops occurrences missed during downtime; a positive window runs them.
   */
  catchupWindowMs: number;
  /** Overlap policy; only "skip" is offered in Phase 1 (skip while prior runs). */
  overlap?: "skip";
  taskQueue?: string;
  /** Create paused (e.g. staging). */
  paused?: boolean;
  /**
   * Standing delegation grant (ticket 020): every occurrence exercises this
   * grant at run start — the ONLY way a scheduled run gets a credential.
   */
  standingGrantId?: string;
}

export async function createAgentSchedule(
  client: Client,
  spec: AgentScheduleSpec,
): Promise<ScheduleHandle> {
  return client.schedule.create({
    scheduleId: spec.scheduleId,
    spec: {
      cronExpressions: [spec.cron],
      timezone: spec.timezone,
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      // Temporal's server enforces a 10s minimum catch-up window (0 would be
      // treated as "unset" → its 60s default), so the "drop missed
      // occurrences" decision maps to that minimum: anything missed for
      // longer than 10s is dropped.
      catchupWindow: Math.max(spec.catchupWindowMs, 10_000),
    },
    state: {
      paused: spec.paused ?? false,
      note: spec.paused ? "created paused" : "created by createAgentSchedule",
    },
    action: {
      type: "startWorkflow",
      workflowType: agentRun,
      workflowId: spec.scheduleId,
      taskQueue: spec.taskQueue ?? TASK_QUEUE,
      args: [
        {
          ...spec.template,
          ...(spec.standingGrantId !== undefined
            ? { standingGrantId: spec.standingGrantId }
            : {}),
        },
      ],
    },
  });
}

export async function describeAgentSchedule(
  client: Client,
  scheduleId: string,
): Promise<ScheduleDescription> {
  return client.schedule.getHandle(scheduleId).describe();
}

export async function pauseAgentSchedule(
  client: Client,
  scheduleId: string,
  note?: string,
): Promise<void> {
  await client.schedule.getHandle(scheduleId).pause(note);
}

export async function resumeAgentSchedule(
  client: Client,
  scheduleId: string,
  note?: string,
): Promise<void> {
  await client.schedule.getHandle(scheduleId).unpause(note);
}

export async function deleteAgentSchedule(client: Client, scheduleId: string): Promise<void> {
  await client.schedule.getHandle(scheduleId).delete();
}

/** Trigger one occurrence now, honoring skip-if-running semantics. */
export async function triggerAgentSchedule(client: Client, scheduleId: string): Promise<void> {
  await client.schedule.getHandle(scheduleId).trigger(ScheduleOverlapPolicy.SKIP);
}
