List the agent secrets stored on this machine.

Each entry shows its name, purpose, scope (every session, or the workspaces it
covers) and whether a usable value exists here. Values are never included: the
model can only reach a secret inside a bash child process as
`$MUSEPI_SECRET_<NAME>`, and only in a workspace the entry covers. Use
`request_secret` when a needed name is missing or not usable here.
