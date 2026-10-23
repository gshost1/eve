import { expect, it, vi } from "vitest";

import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { sendToChannel } from "#execution/tools/workflow/channel-handoff.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";

vi.mock("#execution/tools/workflow/channel-handoff-steps.js", () => ({
  sendToChannelStep: vi.fn(),
}));

function contextOnNode(nodeId: string | undefined): AgentSessionContext {
  const bundle: AgentSessionContext["bundle"] = {
    nodeId,
    source: {} as AgentSessionContext["bundle"]["source"],
  };
  return { bundle } as AgentSessionContext;
}

const options = { auth: null, target: {} };

it.each([undefined, ROOT_RUNTIME_AGENT_NODE_ID])(
  "allows tools on the root agent (%s)",
  async (nodeId) => {
    await expect(
      sendToChannel(contextOnNode(nodeId), "slack", "Hi.", options),
    ).resolves.not.toThrow();
  },
);

it("rejects tools on a subagent, which would otherwise start a root-agent session", async () => {
  await expect(sendToChannel(contextOnNode("researcher"), "slack", "Hi.", options)).rejects.toThrow(
    "ctx.sendToChannel() is only available to workflow tools on the root agent.",
  );
});
