import { defineTool } from "eve/tools";
import { z } from "zod";

import { codeChannelStatus } from "../lib/code-channel";

// eve reads the repository, branch, and diff from the sandbox itself. This tool
// reports what only the agent knows. `channels/slack.ts` shows it in code channels only.
export default defineTool({
  description:
    "In a Slack code channel, show the pull request and test status in the context bar. Call it when you open or update a pull request, and when tests start, pass, or fail. Omitted fields keep their last value. It has no effect outside a code channel.",
  inputSchema: z.object({
    pullRequest: z
      .object({
        number: z.int().positive(),
        state: z.enum(["draft", "open", "merged", "closed"]),
        url: z.url(),
      })
      .optional(),
    tests: z.enum(["passing", "failing", "running"]).optional(),
  }),
  execute: (input) => {
    codeChannelStatus.update((current) => ({ ...current, ...input }));
    return { updated: true };
  },
});
