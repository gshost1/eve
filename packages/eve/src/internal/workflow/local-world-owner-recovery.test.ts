import { describe, expect, it, vi } from "vitest";

import {
  enqueueRecoveredRun,
  listDeadStepOwners,
  RECOVERED_OWNER_MESSAGE_HEADER,
  resolveTrustedDeliveryMessageId,
} from "#internal/workflow/local-world-owner-recovery.js";

const BOOT = Date.parse("2026-10-26T12:00:00.000Z");
const BEFORE = "2026-10-26T11:59:00.000Z";
const AFTER = "2026-10-26T12:00:05.000Z";
const OWNER_A = "msg_01M5WXRQYT19QKFX3S2M59SNAS";
const OWNER_B = "msg_01M5WXRQYT19QKFX3S2M59SNAT";

type TestEvent = {
  eventType: string;
  correlationId?: string;
  createdAt: string;
  eventData?: Record<string, unknown>;
};

const started = (
  correlationId: string,
  owner: string | undefined,
  createdAt = BEFORE,
): TestEvent => ({
  eventType: "step_started",
  correlationId,
  createdAt,
  eventData: owner === undefined ? { stepName: "s" } : { stepName: "s", ownerMessageId: owner },
});
const event = (eventType: string, correlationId: string, createdAt = BEFORE): TestEvent => ({
  eventType,
  correlationId,
  createdAt,
});

function worldWith(pages: TestEvent[][]) {
  const list = vi.fn(async ({ pagination }: { pagination: { cursor?: string } }) => {
    const index = pagination.cursor === undefined ? 0 : Number(pagination.cursor);
    return {
      data: pages[index] ?? [],
      hasMore: index + 1 < pages.length,
      cursor: index + 1 < pages.length ? String(index + 1) : null,
    };
  });
  return { world: { events: { list } } as never, list };
}

describe("listDeadStepOwners", () => {
  it("returns the owner of an unfinished step started before this process", async () => {
    const { world, list } = worldWith([
      [started("step_1", OWNER_A), event("step_completed", "step_1")],
      [started("step_2", OWNER_A)],
    ]);
    expect(await listDeadStepOwners(world, "wrun_1", BOOT)).toEqual([OWNER_A]);
    expect(list.mock.calls.map(([params]) => params)).toEqual([
      { runId: "wrun_1", pagination: { cursor: undefined }, resolveData: "none" },
      { runId: "wrun_1", pagination: { cursor: "1" }, resolveData: "none" },
    ]);
  });

  it("ignores settled, retrying, unstamped and current-process steps", async () => {
    const { world } = worldWith([
      [
        started("done", OWNER_A),
        event("step_failed", "done"),
        started("retried", OWNER_A),
        event("step_retrying", "retried"),
        started("retried", OWNER_A),
        started("eager", undefined),
        started("live", OWNER_B, AFTER),
      ],
    ]);
    expect(await listDeadStepOwners(world, "wrun_1", BOOT)).toEqual([]);
  });

  it("uses the latest step_started and de-duplicates owners", async () => {
    const { world } = worldWith([
      [
        started("step_1", OWNER_B),
        started("step_1", OWNER_A),
        started("step_2", OWNER_A),
        started("step_3", OWNER_B),
      ],
    ]);
    expect(await listDeadStepOwners(world, "wrun_1", BOOT)).toEqual([OWNER_A, OWNER_B]);
  });
});

describe("enqueueRecoveredRun", () => {
  it("names each dead owner in its own wake", async () => {
    const { world } = worldWith([[started("step_1", OWNER_A), started("step_2", OWNER_B)]]);
    const enqueue = vi.fn(async () => {});
    await enqueueRecoveredRun({ world, runId: "wrun_1", processStartedAtMs: BOOT, enqueue });
    expect(enqueue.mock.calls).toEqual([
      [{ [RECOVERED_OWNER_MESSAGE_HEADER]: OWNER_A }],
      [{ [RECOVERED_OWNER_MESSAGE_HEADER]: OWNER_B }],
    ]);
  });

  it("sends a plain wake when no step is owned", async () => {
    const { world } = worldWith([[started("step_1", OWNER_A), event("step_completed", "step_1")]]);
    const enqueue = vi.fn(async () => {});
    await enqueueRecoveredRun({ world, runId: "wrun_1", processStartedAtMs: BOOT, enqueue });
    expect(enqueue.mock.calls).toEqual([[undefined]]);
  });

  it("falls back to a plain wake when the event log cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = {
      events: {
        list: async () => {
          throw new Error("disk");
        },
      },
    } as never;
    const enqueue = vi.fn(async () => {});
    await enqueueRecoveredRun({ world, runId: "wrun_1", processStartedAtMs: BOOT, enqueue });
    expect(enqueue.mock.calls).toEqual([[undefined]]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("resolveTrustedDeliveryMessageId", () => {
  it("prefers a well-formed recovered owner over the queue id", () => {
    const headers = new Headers({
      "x-vqs-message-id": "msg_01M5WXRQYT19QKFX3S2M59SNAZ",
      [RECOVERED_OWNER_MESSAGE_HEADER]: OWNER_A,
    });
    expect(resolveTrustedDeliveryMessageId(headers)).toBe(OWNER_A);
  });

  it("keeps the queue id when the recovered owner is absent or malformed", () => {
    const queueId = "msg_01M5WXRQYT19QKFX3S2M59SNAZ";
    expect(resolveTrustedDeliveryMessageId(new Headers({ "x-vqs-message-id": queueId }))).toBe(
      queueId,
    );
    expect(
      resolveTrustedDeliveryMessageId(
        new Headers({ "x-vqs-message-id": queueId, [RECOVERED_OWNER_MESSAGE_HEADER]: "../x" }),
      ),
    ).toBe(queueId);
  });
});
