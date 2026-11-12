Show the user a progress update without ending your turn. The update appears in the conversation with a title and a short body, and it stays visible after the turn folds.

Use it when the work will take more than a few steps:
1. Early in a multi-step task, state the approach so the user can follow the work.
2. After a meaningful finding or phase conclusion, say what is confirmed and what is still a hypothesis.
3. Before a long-running step, say what you are waiting for and why.
4. When blocked, name the blocker and your next step.

Guidelines:
- `title` is one line, no markdown, no trailing period.
- `message` reads like a chat update to a colleague: two to four sentences of evidence and reasoning, then details as short bullets or key-value lines. Keep it self-contained.
- Do not repeat status that has not changed, and do not narrate individual tool calls.
- Do not use this to ask questions, request decisions, or deliver the final answer — the turn continues after the update.
