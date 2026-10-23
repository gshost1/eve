---
"eve": patch
---

Set `codeChannels: true` on `slackChannel()` to serve Slack code channels as one session per channel. The agent answers un-mentioned messages, replies top-level or in the thread a person wrote in, and follows Slack's session status and stop. The option also adds the code channel scopes and events to the app manifest.
