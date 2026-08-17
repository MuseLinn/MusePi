End active checkpoint; rewind context to it, replacing intermediate exploration with your report.

Call immediately after investigative work started by `checkpoint`.

Requirements:
- `report` MUST be concise, factual, actionable; include key findings, decisions, unresolved risks.
- AVOID raw scratch logs unless essential.
- MUST call before yielding if checkpoint active.

Behavior:
- No active checkpoint → error. Checkpoint already rewound → continue from retained report; NEVER retry.
- Success → session rewinds, retains your report as context, closes checkpoint.
- Successful rewind final for that checkpoint; repeat calls error.
