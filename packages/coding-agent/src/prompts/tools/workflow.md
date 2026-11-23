Run a model-authored JavaScript workflow that delegates work to subagents and returns the script's value.

Use it only when the user explicitly asks for a workflow or for large multi-agent orchestration; prefer one or two plain subagent calls otherwise. The script body runs in the session's JavaScript kernel with `args`, `agent()`, `parallel()`, `pipeline()`, `log()`, `phase()`, `budget` and `tool.<name>()` available.

A foreground call waits for every child and returns the final value. `run_in_background: true` returns a job id at once and delivers the result in a later turn. A failed or cancelled run reports the failure, never partial success.