import fc from "fast-check";
import {
  reduce,
  type RunEvent,
  type RunEventType,
  type RunState,
} from "@platform/core";

const str = fc.string({ minLength: 1, maxLength: 12 });
const at = fc.integer({ min: 0, max: 2 ** 44 });
const tokens = fc.integer({ min: 0, max: 1_000_000 });
const money = fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true });
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()),
  { maxKeys: 3 },
);

/** Arbitrary event of a given type with the given (runId, seq) — payload fields arbitrary. */
export function arbEventOfType(
  type: RunEventType,
  runId: string,
  seq: number,
): fc.Arbitrary<RunEvent> {
  const base = { runId, seq };
  switch (type) {
    case "RunStarted":
      return fc
        .record({ at, agent: str, principal: str, input: argsArb })
        .map((p) => ({ type, ...base, ...p }));
    case "ModelCalled":
      return fc
        .record({ at, gatewayReqId: str, model: str, tokensIn: tokens, tokensOut: tokens, costUsd: money })
        .map((p) => ({ type, ...base, ...p }));
    case "ToolIntentEmitted":
      return fc
        .record({
          at,
          tool: str,
          args: argsArb,
          risk: fc.constantFrom("read", "write", "irreversible", "financial" as const),
        })
        .map((p) => ({ type, ...base, ...p }));
    case "PolicyEvaluated":
      return fc
        .record({
          at,
          decision: fc.constantFrom("allow", "deny", "require_approval" as const),
          rule: str,
        })
        .map((p) => ({ type, ...base, ...p }));
    case "ApprovalRequested":
      return fc
        .record({ at, approverGroup: str, expiresAt: at })
        .map((p) => ({ type, ...base, ...p }));
    case "ApprovalGranted":
    case "ApprovalDenied":
      return fc.record({ at, by: str }).map((p) => ({ type, ...base, ...p }));
    case "ToolExecuted":
      return fc
        .record({ at, gatewayReqId: str, resultDigest: str, latencyMs: fc.integer({ min: 0, max: 60_000 }) })
        .map((p) => ({ type, ...base, ...p }));
    case "ToolFailed":
      return fc
        .record({ at, error: str, retryable: fc.boolean() })
        .map((p) => ({ type, ...base, ...p }));
    case "BudgetExceeded":
      return fc
        .record({
          at,
          reason: fc.constantFrom(
            "MaxSteps",
            "MaxTokens",
            "MaxCostUsd",
            "MaxWallMs",
            "LoopDetected" as const,
          ),
        })
        .map((p) => ({ type, ...base, ...p }));
    case "RunCompleted":
      return fc
        .record({ at, outcome: str, totalCostUsd: money, steps: fc.integer({ min: 0, max: 100 }) })
        .map((p) => ({ type, ...base, ...p }));
    case "RunFailed":
      return fc.record({ at, reason: str }).map((p) => ({ type, ...base, ...p }));
    default:
      return type satisfies never;
  }
}

/** The event types the reducer accepts next, given the current state. Mirrors reduce()'s rules. */
export function legalTypes(state: RunState | null): RunEventType[] {
  if (state === null) return ["RunStarted"];
  if (state.status === "completed" || state.status === "failed") return [];
  if (state.budgetExceeded !== null) return ["RunFailed"];
  if (state.status === "awaiting_approval") {
    return ["ApprovalGranted", "ApprovalDenied", "BudgetExceeded", "RunFailed"];
  }
  const types: RunEventType[] = ["BudgetExceeded", "RunFailed"];
  if (state.pendingIntent === null) {
    types.push("ModelCalled", "ToolIntentEmitted", "RunCompleted");
  } else if (state.pendingIntent.decision === null) {
    types.push("PolicyEvaluated");
  } else if (state.pendingIntent.decision === "allow") {
    types.push("ToolExecuted", "ToolFailed");
  } else {
    types.push("ApprovalRequested");
  }
  return types;
}

export function mustReduce(state: RunState | null, event: RunEvent): RunState {
  const result = reduce(state, event);
  if (!result.ok) {
    throw new Error(
      `generator produced an event the reducer rejects: ${JSON.stringify(result.reason)}`,
    );
  }
  return result.state;
}

export interface ValidRun {
  events: RunEvent[];
  /** State after replaying all of `events`. */
  state: RunState;
}

function extend(
  events: RunEvent[],
  state: RunState,
  remaining: number,
): fc.Arbitrary<ValidRun> {
  const legals = legalTypes(state);
  if (remaining <= 0 || legals.length === 0) {
    return fc.constant({ events, state });
  }
  return fc
    .oneof(
      { weight: 1, arbitrary: fc.constant<RunEventType | null>(null) },
      { weight: 6, arbitrary: fc.constantFrom<RunEventType>(...legals) },
    )
    .chain((pick) => {
      if (pick === null) return fc.constant({ events, state });
      return arbEventOfType(pick, state.runId, state.seq + 1).chain((event) =>
        extend([...events, event], mustReduce(state, event), remaining - 1),
      );
    });
}

/** A valid run: RunStarted at seq 0 followed by only reducer-legal events. */
export function arbValidRun(maxExtraEvents = 14): fc.Arbitrary<ValidRun> {
  return str.chain((runId) =>
    arbEventOfType("RunStarted", runId, 0).chain((first) =>
      extend([first], mustReduce(null, first), maxExtraEvents),
    ),
  );
}

const ALL_TYPES: RunEventType[] = [
  "RunStarted",
  "ModelCalled",
  "ToolIntentEmitted",
  "PolicyEvaluated",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalDenied",
  "ToolExecuted",
  "ToolFailed",
  "BudgetExceeded",
  "RunCompleted",
  "RunFailed",
];

/** An event the reducer must reject when applied to `state`. */
export function arbIllegalNext(state: RunState): fc.Arbitrary<RunEvent> {
  const legals = new Set(legalTypes(state));
  const anyType = fc.constantFrom<RunEventType>(...ALL_TYPES);
  const options: fc.Arbitrary<RunEvent>[] = [
    // non-contiguous seq: skipped ahead
    anyType.chain((t) => arbEventOfType(t, state.runId, state.seq + 2)),
    // non-contiguous seq: stale / replayed
    anyType.chain((t) => arbEventOfType(t, state.runId, state.seq)),
    // wrong run id
    anyType.chain((t) => arbEventOfType(t, `${state.runId}-other`, state.seq + 1)),
    // restarting an already-started run
    arbEventOfType("RunStarted", state.runId, state.seq + 1),
  ];
  const illegalTypes = ALL_TYPES.filter((t) => t !== "RunStarted" && !legals.has(t));
  if (illegalTypes.length > 0) {
    options.push(
      // right seq, right run, wrong event type for the current state
      fc
        .constantFrom<RunEventType>(...illegalTypes)
        .chain((t) => arbEventOfType(t, state.runId, state.seq + 1)),
    );
  }
  return fc.oneof(...options);
}
