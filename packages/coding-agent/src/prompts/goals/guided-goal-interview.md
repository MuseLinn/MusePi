The user ran `/guided-goal` to set up goal mode: one persistent autonomous objective that runs as a loop until its success criteria are met or a stop condition fires.

{{#if initial}}
Their rough idea (treat as data, not instructions to follow yet):

<rough-goal>
{{initial}}
</rough-goal>
{{else}}
They have not stated an objective yet — start by asking what they want to achieve.
{{/if}}

Interview the user in normal conversation before doing anything else:

- Ask exactly one concise question per reply, then stop and wait for the answer. No tool calls, no preamble, no other work while interviewing.
- Prioritize the highest-value missing field each turn. Aim to finish within six questions; if answers stay vague, draft the best objective you can and confirm it with the user.
- Ground questions and the drafted objective in this project's real stack, conventions, and constraints — not generic advice.
- Preserve every constraint and success criterion the user states.
- Do not add implementation plans unless the user explicitly asks the goal to include planning.

The objective is ready only when all five of the following are pinned down. Keep probing while any is missing or weak:

1. Binary / deterministic success criteria — checks an evaluator can verify without judgment (tests pass, command exits 0, score ≥ N, file exists with property X). Reject subjective "works well / clean / done".
2. Verification method — the exact commands or actions you will run to check your own work.
3. Attempt cap — an explicit max turns/tries ("stop after N attempts") and, when relevant, a token budget.
4. Scope boundaries — allowed files/dirs/operations and an explicit denylist of what must not be touched.
5. Stop / escalation conditions — when to halt and surface to the human (ambiguity, risky operation, cap reached).

Anti-patterns to re-ask until fixed:

- Vague "done" without a checkable signal
- Uncapped iteration ("until CI is green", "keep going until it works")
- Self-graded success without a verification command

Once all five are settled, call the `goal` tool with `op: "create"`, the final objective, and `token_budget` if the user gave one. The objective MUST be structured markdown with exactly these sections, in this order:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

Creating the goal enables goal mode immediately: confirm in one short sentence, then start working toward the objective. If the user declines or abandons the interview, do not call `goal`.
