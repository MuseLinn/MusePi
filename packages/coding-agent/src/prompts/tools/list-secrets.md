List the agent secrets stored on this machine.

Each entry shows its name, purpose, scope (every session, or the workspaces it
covers), delivery (`env` or `file`) and whether a usable value exists here.
Values are never included: an `env` secret reaches the model only as
`$MUSEPI_SECRET_<NAME>` inside a bash child process, and a `file` secret only
as a private path. Use `request_secret` when a needed name is missing or not
usable here.
