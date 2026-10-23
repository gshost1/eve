import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { WorkflowToolContext } from "#public/tools/index.js";
import { executeOpenCodeChannel } from "#tools/provided/open-code-channel-workflow.js";

function contextFor(auth: SessionAuthContext | null): WorkflowToolContext {
  return {
    channel: { kind: "channel:slack", name: "slack" },
    session: { auth: { current: auth }, id: "session_thread" },
  } as never;
}

function slackAuth(attributes: Record<string, string>): SessionAuthContext {
  return {
    attributes: { channel_id: "C1", user_id: "U1", ...attributes },
    authenticator: "slack-webhook",
    issuer: "slack:T1",
    principalId: "slack:T1:U1",
    principalType: "user",
  };
}

const input = { message: "Start by reproducing it.", name: "Fix the login test" };

describe("executeOpenCodeChannel", () => {
  it.each([
    ["a session without auth", null],
    [
      "a non-Slack session",
      {
        attributes: { channel_id: "C1", thread_ts: "1.1" },
        authenticator: "teams",
        principalId: "p",
        principalType: "user",
      } satisfies SessionAuthContext,
    ],
  ])("is unavailable for %s", async (_name, auth) => {
    await expect(executeOpenCodeChannel(input, contextFor(auth))).resolves.toEqual({
      reason: "This conversation is not a Slack message.",
      status: "unavailable",
    });
  });

  it("is unavailable inside a code channel", async () => {
    const auth = slackAuth({ code_channel: "true", message_ts: "1.2" });
    await expect(executeOpenCodeChannel(input, contextFor(auth))).resolves.toEqual({
      reason: "This conversation is already a code channel.",
      status: "unavailable",
    });
  });
});
