Your yield was recorded, but {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after these jobs settle AND you submit a fresh `yield` that accounts for their results. Job results arrive as follow-up messages; a result that arrives after your yield supersedes it — your current yield will NOT be accepted as the final report. Decide now:
- Need the results? Wait for them (`hub` op:"wait"), then submit a fresh `yield` that incorporates them.
- Job no longer needed? Cancel it (`hub` op:"cancel", ids:[…]) and re-yield.
- Otherwise stand by; when each result arrives, submit a fresh `yield` (repeat your report unchanged if the result does not affect it).
