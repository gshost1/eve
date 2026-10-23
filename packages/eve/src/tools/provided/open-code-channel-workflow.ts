import { transcriptReducer } from "#client/index.js";
import { sessions } from "#public/server/index.js";
import type { SlackChannel } from "#public/channels/slack/index.js";
import type { WorkflowToolContext } from "#public/tools/index.js";
import type {
  OpenCodeChannelInput,
  OpenCodeChannelOutput,
} from "#tools/provided/open-code-channel.js";

/**
 * Forks the calling Slack conversation into a new code channel, through the
 * Slack channel that serves this session. Built on public APIs only, so an
 * agent can author a variant with its own inputs and behavior.
 */
export async function executeOpenCodeChannel(
  input: OpenCodeChannelInput,
  ctx: WorkflowToolContext,
): Promise<OpenCodeChannelOutput> {
  "use workflow";

  // Slack auth names the conversation and the message that triggered the turn.
  const auth = ctx.session.auth.current;
  const { name } = ctx.channel;
  const attributes: Readonly<Record<string, unknown>> =
    auth?.authenticator === "slack-webhook" ? auth.attributes : {};
  const { channel_id: channelId, message_ts: messageTs, thread_ts: threadTs } = attributes;
  // Slack doesn't open a code channel from inside one.
  if (attributes.code_channel === "true") {
    return unavailable("This conversation is already a code channel.");
  }
  if (name === undefined || typeof channelId !== "string" || typeof threadTs !== "string") {
    return unavailable("This conversation is not a Slack message.");
  }

  // The issuer names the workspace whose installation received the message.
  const installationTeamId = auth?.issuer?.startsWith("slack:")
    ? auth.issuer.slice("slack:".length)
    : undefined;
  const history = await readSessionTranscript(ctx.session.id);
  // Slack refusals fail the call with Slack's error, which the model can relay.
  const { sessionId } = await ctx.sendToChannel<SlackChannel>(name, input.message, {
    target: {
      channelId,
      // Slack checks this session is the origin thread's before creating anything.
      codeChannel: {
        name: input.name,
        originThreadTs: threadTs,
        // A turn a click started has no message of its own, so it opens from the thread.
        originTs: typeof messageTs === "string" ? messageTs : threadTs,
      },
      ...(installationTeamId !== undefined && { installationTeamId }),
    },
    auth,
    history,
  });
  return { sessionId, status: "opened" };
}

function unavailable(reason: string): OpenCodeChannelOutput {
  return { reason, status: "unavailable" };
}

async function readSessionTranscript(sessionId: string) {
  "use step";
  const reducer = transcriptReducer();
  let transcript = reducer.initial();
  for await (const event of sessions.attach(sessionId).stream({ follow: false })) {
    transcript = reducer.reduce(transcript, event);
  }
  return transcript.messages;
}
