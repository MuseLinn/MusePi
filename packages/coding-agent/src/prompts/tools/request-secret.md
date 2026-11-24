Ask the user for a secret the agent needs inside a bash command.

The tool takes only a NAME and a PURPOSE. It never accepts or returns the secret value:
- If NAME is stored, readable and allowed in this workspace, it returns the environment variable name immediately; saving already granted it, so there is no second consent card.
- If NAME is stored but scoped to other workspaces, it opens an "allow" card so the user can extend the scope here without retyping the value.
- Otherwise it opens a card for the user. Saving stores the value locally (encrypted); cancelling saves nothing.
- The user may scope a saved value to every session or just the asking workspace, and a new save may use `delivery: "file"` instead of the default `"env"`. `list_secrets` reports both.
- On success, an `env` value reaches only bash child processes as `$MUSEPI_SECRET_<NAME>`; a `file` value is written to a private owner-only file under the agent directory and the result names that path (it is never exported to the environment).
- The model never sees the value in this tool's result, in bash output, or in a provider request.
- If a command prints that variable, the output contains `[secret:<NAME>]` instead of the value. That marker is expected redaction, not an error; do not retry or report a failure because of it.

Use this instead of asking the user to paste a key into chat. Names use A-Z, 0-9 and _ and start with a letter. Values need at least 4 characters; a value of 4-7 characters is redacted only where it stands alone in text.
