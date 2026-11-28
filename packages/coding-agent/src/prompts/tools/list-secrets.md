List the agent credentials stored on this machine.

Each entry shows its name, purpose, kind, scope (every session, or the
workspaces it covers) and whether it is usable here. Values are never included.

- A `secret` reaches the model only as `$MUSEPI_SECRET_<NAME>` inside a bash
  child process, or as a private `file` path. Its delivery is `env` or `file`.
- A `login` is a website sign-in. It lists its site, username and whether a 2FA
  key is stored, and no value ever reaches you: sign in with the browser tool's
  `action:"fill_login"` and its name.

Use `request_secret` when a needed secret name is missing or not usable here,
and `request_login` when no login covers the site you are on.