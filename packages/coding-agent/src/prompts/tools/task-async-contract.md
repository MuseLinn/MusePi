No polling needed.

Settled-job inspection: `hub jobs` | `hub wait` delivers its snapshot → no duplicate `async-result`.

Job IDs: process memory ~5min after settlement; afterward use agent ID: `hub send`, `agent://<id>`, `history://<id>`.

`completed`: subagent yielded successfully; claimed artifacts unverified.

Execution mode override: a `task` call's per-item `blocking` field overrides the agent's declared mode — `blocking: true` runs inline (the parent waits on this turn), `blocking: false` forces a background job. Omit it to follow the agent's default.
