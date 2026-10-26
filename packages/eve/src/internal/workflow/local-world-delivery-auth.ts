import { randomBytes } from "node:crypto";

import type { ValidQueueName } from "#compiled/@workflow/world/index.js";
import type { LocalWorld } from "#compiled/@workflow/world-local/index.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  enqueueRecoveredRun,
  RECOVERED_OWNER_MESSAGE_HEADER,
  resolveTrustedDeliveryMessageId,
} from "#internal/workflow/local-world-owner-recovery.js";
import {
  workflowQueuePrefix,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";

export const LOCAL_WORKFLOW_DELIVERY_HEADER = "x-eve-workflow-delivery";

/**
 * Makes the local World's flow route accept only deliveries this process
 * enqueued. The route is as reachable as the server, and world-local trusts
 * whatever `x-vqs-*` headers and body arrive, so without a proof any client
 * could forge a delivery, including its run context and principal.
 *
 * The proof is a random per-process secret that never leaves the process:
 * the local World only delivers to the server that enqueued. world-local's
 * own startup recovery enqueues past the wrapped queue, so the World must be
 * created with `recoverActiveRuns: false`; `start()` recovers through the
 * stamped queue instead.
 *
 * Mutates and returns `world`.
 */
export function authenticateLocalWorkflowDeliveries(
  world: LocalWorld,
  secret: string = randomBytes(32).toString("hex"),
): LocalWorld {
  const enqueue = world.queue.bind(world);
  world.queue = async (queueName, message, options) =>
    await enqueue(queueName, message, {
      ...options,
      headers: { ...options?.headers, [LOCAL_WORKFLOW_DELIVERY_HEADER]: secret },
    });

  const createQueueHandler = world.createQueueHandler.bind(world);
  world.createQueueHandler = (queueNamePrefix, handler) => {
    const deliver = createQueueHandler(queueNamePrefix, handler);
    return async (request) => {
      const proof = request.headers.get(LOCAL_WORKFLOW_DELIVERY_HEADER);
      if (proof === null || !timingSafeEqualStrings(proof, secret)) {
        return Response.json({ error: "Untrusted workflow delivery." }, { status: 401 });
      }
      if (!request.headers.has(RECOVERED_OWNER_MESSAGE_HEADER)) return await deliver(request);
      // Startup recovery named the dead owner of an interrupted step: present
      // its id so the runtime re-runs the step now (see local-world-owner-recovery).
      const headers = new Headers(request.headers);
      const messageId = resolveTrustedDeliveryMessageId(headers);
      headers.delete(RECOVERED_OWNER_MESSAGE_HEADER);
      if (messageId !== null) headers.set("x-vqs-message-id", messageId);
      // Copy by parts: the server's request object need not be a native Request.
      const body = await request.arrayBuffer();
      return await deliver(new Request(request.url, { body, headers, method: request.method }));
    };
  };

  const start = world.start?.bind(world);
  world.start = async () => {
    // Every queue message from before this point died with its process.
    const processStartedAtMs = Date.now();
    await start?.();
    await reenqueueActiveRuns(world, processStartedAtMs);
  };
  return world;
}

/** Mirrors world-local's startup recovery, but through the stamped `world.queue`. */
async function reenqueueActiveRuns(world: LocalWorld, processStartedAtMs: number): Promise<void> {
  const namespace = process.env[WORKFLOW_QUEUE_NAMESPACE_ENV];
  if (!namespace) {
    throw new Error(
      `${WORKFLOW_QUEUE_NAMESPACE_ENV} must be installed before local workflow recovery.`,
    );
  }
  const prefix = workflowQueuePrefix(namespace);
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      pagination: { cursor },
      resolveData: "none",
      status: ["pending", "running"],
    });
    for (const run of page.data) {
      try {
        await enqueueRecoveredRun({
          world,
          runId: run.runId,
          processStartedAtMs,
          enqueue: async (headers) =>
            await world.queue(
              `${prefix}${run.workflowName}` as ValidQueueName,
              { runId: run.runId },
              headers === undefined ? undefined : { headers },
            ),
        });
      } catch (error) {
        console.warn(`[eve] Failed to re-enqueue workflow run ${run.runId}:`, error);
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
}
