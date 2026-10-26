---
"eve": patch
---

On the built-in local Workflow World, a step that was executing when the server died now runs again as soon as `eve dev --resume` or `eve start` recovers its run. Before, the run stayed frozen until the dead process's 860-second inline ownership lease expired, and messages sent in the meantime were accepted without any sign of progress.
