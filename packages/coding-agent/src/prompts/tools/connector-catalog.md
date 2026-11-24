Discover the connectors this machine can mount. A connector is a remote MCP server plus display and auth metadata; connecting one adds its tools to the session.

- `list` — every catalog entry, with `enabled` state. Start here when the user asks what integrations exist or asks you to connect a service.
- `search` — case-insensitive match over id, name, description and category. Use the service or vendor name the user gave.
- `detail` — one entry's endpoint, auth mode, docs and example prompts. Call it before recommending a specific connector.
- `request` — ask the user to connect one entry, with a one-sentence `purpose` saying why this turn needs it. A card appears in the conversation; the user decides. Returns `connected`, `declined`, `needs-user` or `error`, and you carry on from that answer.

Rules:

- Report only what the tool returns. Never invent a connector id, endpoint or capability, and never claim a connector is connected unless the output says `connected`.
- Use `request` when you are mid-task and a connector would let you finish it. Do not use it to browse: `list` and `search` are for discovery.
- A `request` answer of `needs-user` means the click cannot finish the job — a browser sign-in, a token, or a local-command approval has to happen in Settings → Connectors. Tell the user that in one sentence; do not retry the same request.
- After `connected`, the connector's tools appear on the next step. Use them normally.
- Never edit `mcp.json`, call an OAuth endpoint yourself, or paste tokens into a command.
- If the catalog is empty, say so and point the user at the connectors folder or catalog source instead of guessing an integration.
- `auth: oauth` means the first connection opens a browser authorization; `auth: none` connects without a grant; `auth: token` needs the user to fill the connector's Token form before the tools mount. A `stdio` connector runs a local command and needs the user's explicit approval; a managed CLI connector installs into an isolated prefix and shows its device code. Never ask the user to paste a token into chat, run the connector command yourself, or install its package.
