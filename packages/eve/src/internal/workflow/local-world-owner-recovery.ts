import type { World } from "#compiled/@workflow/world/index.js";

/**
 * Restores the "owner redelivery" path for runs recovered by a fresh process
 * on the local Workflow World.
 *
 * Workflow stamps every inline step's `step_started` with the queue message
 * that owns it. A wake replay that finds an owned, unfinished step assumes the
 * owner may still be running and arms a delayed backstop for the rest of the
 * ownership lease (860 s by default) instead of re-running the step. On a
 * queue with durable messages the owner's own message redelivers after a
 * crash, matches the stamp, and re-runs the step at once ("owned recovery").
 *
 * world-local's queue lives in process memory, so a crash loses the owning
 * message with the process. Startup recovery re-enqueues the run under a new
 * message id, which never matches the stamp, and the step stays frozen until
 * the lease expires. Every message enqueued before this process started is
 * gone, so its owner is dead by construction: recovery enqueues one delivery
 * per dead owner that names it, and the trusted delivery handler presents that
 * id to the runtime, which then takes its owned-recovery path.
 *
 * The header is honoured only on deliveries that already passed the
 * per-process delivery proof, so a client cannot borrow another message's
 * identity.
 */
export const RECOVERED_OWNER_MESSAGE_HEADER = "x-eve-workflow-recovered-owner";

const QUEUE_MESSAGE_ID = /^msg_[0-9A-Za-z]{10,64}$/;

/** Whether `value` is shaped like a world-local queue message id. */
export function isQueueMessageId(value: string | null | undefined): value is string {
  return typeof value === "string" && QUEUE_MESSAGE_ID.test(value);
}

/**
 * The message id a trusted delivery presents to the runtime: the recovered
 * owner's id when recovery named one, otherwise the queue's own id.
 */
export function resolveTrustedDeliveryMessageId(headers: Headers): string | null {
  const recoveredOwner = headers.get(RECOVERED_OWNER_MESSAGE_HEADER);
  if (isQueueMessageId(recoveredOwner)) return recoveredOwner;
  return headers.get("x-vqs-message-id");
}

type StepOwnership = {
  owner: string | undefined;
  startedAtMs: number;
  lapsed: boolean;
  settled: boolean;
};

/**
 * Owner message ids of the run's unfinished inline-owned steps whose latest
 * `step_started` was written before `processStartedAtMs`. Mirrors the
 * runtime's ownership rule: the latest `step_started` carries the owner, and a
 * `step_retrying` lapses ownership for good (the step is then queue-owned and
 * dispatches without a lease).
 */
export async function listDeadStepOwners(
  world: Pick<World, "events">,
  runId: string,
  processStartedAtMs: number,
): Promise<string[]> {
  const steps = new Map<string, StepOwnership>();
  let cursor: string | undefined;
  do {
    const page = await world.events.list({ runId, pagination: { cursor }, resolveData: "none" });
    for (const event of page.data) {
      const correlationId = event.correlationId;
      if (correlationId === undefined) continue;
      if (event.eventType === "step_started") {
        const previous = steps.get(correlationId);
        const data = (event as { eventData?: { ownerMessageId?: unknown } }).eventData;
        steps.set(correlationId, {
          owner: typeof data?.ownerMessageId === "string" ? data.ownerMessageId : undefined,
          startedAtMs: new Date(event.createdAt).getTime(),
          lapsed: previous?.lapsed ?? false,
          settled: false,
        });
      } else if (event.eventType === "step_retrying") {
        const step = steps.get(correlationId);
        if (step) step.lapsed = true;
      } else if (event.eventType === "step_completed" || event.eventType === "step_failed") {
        const step = steps.get(correlationId);
        if (step) step.settled = true;
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);

  const owners = new Set<string>();
  for (const step of steps.values()) {
    if (step.settled || step.lapsed || !isQueueMessageId(step.owner)) continue;
    if (!(step.startedAtMs < processStartedAtMs)) continue;
    owners.add(step.owner);
  }
  return [...owners];
}

/**
 * Enqueues the startup-recovery wake for one run: a plain wake as before, plus
 * one wake per dead step owner so the runtime re-runs those steps now instead
 * of after the ownership lease. A failure to read the event log falls back to
 * the plain wake alone.
 */
export async function enqueueRecoveredRun(input: {
  readonly world: Pick<World, "events">;
  readonly runId: string;
  readonly processStartedAtMs: number;
  readonly enqueue: (headers: Record<string, string> | undefined) => Promise<unknown>;
}): Promise<void> {
  let owners: string[] = [];
  try {
    owners = await listDeadStepOwners(input.world, input.runId, input.processStartedAtMs);
  } catch (error) {
    console.warn(
      `[eve] Could not read step ownership for recovered workflow run ${input.runId}; ` +
        "its interrupted step resumes when the ownership lease expires.",
      error,
    );
  }
  if (owners.length === 0) {
    await input.enqueue(undefined);
    return;
  }
  for (const owner of owners) {
    await input.enqueue({ [RECOVERED_OWNER_MESSAGE_HEADER]: owner });
  }
}
