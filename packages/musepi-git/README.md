# musepi-git

First-party MusePi plugin. Registers `/git`, which reports the repository state
of the session's working directory: branch (or detached HEAD), short commit, and
working-tree counts.

## Why it reads through the host

All git access goes through the host's central helper (`repo.root`,
`head.resolve`, `status.summary` from `@musepi/pi-coding-agent`). A plugin that
shells out to `git` itself becomes a second implementation of command timeouts,
output caps, reftable detection and Windows spawn handling.

Ahead/behind is deliberately not reported: the central helper has no reader for
it. Adding tracking counts is a change to `utils/git.ts`, not to a plugin.

## Layout

| File                 | Role                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `src/index.ts`       | Entry point named in the manifest. Wires modules together, does nothing else. |
| `src/git-command.ts` | The `/git` command registration.                                              |
| `src/repo-state.ts`  | Reads repository state through the host helper.                               |
| `src/format.ts`      | Pure state → one-line rendering.                                              |

The entry is deliberately thin: the install → load → submodule-HMR path needs a
real multi-file consumer, not only fixtures.

## Install

The plugin ships in the bundled `packages/marketplace.json` catalog under the
name `musepi-git`.

## License

UNLICENSED — first-party MusePi code.
