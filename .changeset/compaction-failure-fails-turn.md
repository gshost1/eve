---
"eve": patch
---

A compaction summary call that fails during a turn now fails that turn with `MODEL_CALL_FAILED` and leaves the session waiting with its history uncompacted, so the next message can try again. Before, the error escaped the turn step, Workflow retried the step and the session ended with `FatalError`.
