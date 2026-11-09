Discover the connectors this machine can mount. A connector is a remote MCP server plus display and auth metadata; connecting one adds its tools to the session.

- `list` — every catalog entry, with `enabled` state. Start here when the user asks what integrations exist or asks you to connect a service.
- `search` — case-insensitive match over id, name, description and category. Use the service or vendor name the user gave.
- `detail` — one entry's endpoint, auth mode, docs and example prompts. Call it before recommending a specific connector.

Rules:

- Report only what the tool returns. Never invent a connector id, endpoint or capability, and never claim a connector is connected unless the output says `connected`.
- Enabling a connector and completing OAuth are user actions in the Connectors UI. Do not edit `mcp.json`, call an OAuth endpoint yourself, or paste tokens into a command.
- When the user picks a connector, tell them to open Connectors, select it, and finish the authorization prompt. After it connects, its tools appear automatically as MCP tools; use them normally.
- If the catalog is empty, say so and point the user at the connectors folder or catalog source instead of guessing an integration.
- `auth: oauth` means the first connection opens a browser authorization; `auth: none` connects without a grant; `auth: token` needs the user to fill the connector's Token form before the tools mount. A `stdio` connector runs a local command and needs the user's explicit approval in the Connectors page; a managed CLI connector installs into an isolated prefix and shows its device code there. Never ask the user to paste a token into chat, run the connector command yourself, or install its package.
