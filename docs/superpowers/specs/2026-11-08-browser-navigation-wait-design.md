# Browser navigation and waiting

## Intent

Close the navigation lifecycle gap in the existing browser tool. Agents can navigate and search explicitly, move through history, reload or stop loading, and wait for load or page conditions with observable evidence.

## Goals

- `navigate`, `search`, `back`, `forward`, `reload`, `stop`, and `wait_load` return actual current URL/title and action details.
- Search uses `browser.searchEngine` with the same google/bing/duckduckgo/baidu mapping as the managed address bar.
- `wait_for` supports element role/name/exact with visible/hidden/enabled, text exact/contains with present/absent, and URL exact/prefix. Timeout defaults to 10000 ms (max 30000); `stableForMs` is 0–5000.
- Wait results include matched/timeout outcome and `lastObserved`; timeout is an error result with the same evidence, not a generic timeout.
- Navigation and wait cards, prompt guidance, docs and changelog reflect the real results.

## Non-goals

- No second browser runtime, no raw-code requirement for basic navigation, and no blind waiting for a future navigation when the document already satisfies the requested state.
- No visual click-if-interactive or remaining visual actions in this phase; those are a later acceptance item.
- No full-parity claim from this phase alone.

## Approaches

1. **Compile into the existing run scope (selected).** Navigation helpers generate `tab.goto`/Puppeteer history calls; waiting polls `tab.evaluate` and returns structured observations.
2. **Renderer-only navigation.** Rejected: headless and managed backends need the same real behavior and result authority.
3. **Raw `page.waitForNavigation` for every state.** Rejected: already-satisfied document states must return immediately instead of waiting for another navigation.

## Verification

- Schema/helper tests cover search mapping, required inputs, history actions and wait validation.
- Action/card tests cover navigation and timeout/matched evidence.
- An isolated real page verifies back/forward, reload/stop, load state, element/text/URL matching, stability and timeout evidence.
