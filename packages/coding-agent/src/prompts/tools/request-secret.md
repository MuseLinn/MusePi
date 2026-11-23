Ask the user for a secret the agent needs inside a bash command.

The tool takes only a NAME and a PURPOSE. It never accepts or returns the secret value:
- If NAME is already stored and readable, it returns the environment variable name immediately; saving already granted it, so there is no second consent card.
- Otherwise it opens a card for the user. Saving stores the value locally (encrypted); cancelling saves nothing.
- On success, the value reaches only bash child processes as `$MUSEPI_SECRET_<NAME>`.
- The model never sees the value in this tool's result, in bash output, or in a provider request.
- If a command prints that variable, the output contains `[secret:<NAME>]` instead of the value. That marker is expected redaction, not an error; do not retry or report a failure because of it.

Use this instead of asking the user to paste a key into chat. Names use A-Z, 0-9 and _ and start with a letter.
