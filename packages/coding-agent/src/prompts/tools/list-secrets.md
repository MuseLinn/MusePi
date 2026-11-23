List the agent secrets stored on this machine.

Each entry shows its name, purpose, scope and whether a usable value exists.
Values are never included: the model can only reach a secret inside a bash
child process as `$MUSEPI_SECRET_<NAME>`. Use `request_secret` when a needed
name is missing.
