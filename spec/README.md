# Recovery protocol models

These four independent TLA+ models pin the recovery boundaries implemented in this change. They do not prove refinement of the TypeScript runtime, provider behavior, or external exactly-once effects. All `.tla` and `.cfg` files in this directory share a 5,000-line budget, including comments and blank lines.

## Models and expected results

| Model | Passing configuration | Expected counterexample |
| --- | --- | --- |
| `Lease.tla` | `Lease_Safe.cfg` | `Lease_StaleHeartbeat.cfg` violates `NoStaleHeartbeat` when transitions are not serialized. |
| `JournalAppend.tla` | `JournalAppend_Safe.cfg` | `JournalAppend_DropMiddle.cfg` violates `NoSilentCatchup`; `JournalAppend_Renumber.cfg` violates `NoRenumber`. |
| `IntentBeforeEffect.tla` | `IntentBeforeEffect_Safe.cfg` | `IntentBeforeEffect_SyncEffect.cfg` violates `EffectAfterDurable`. |
| `HostPluginLifecycle.tla` | `HostPluginLifecycle_Safe.cfg` | `HostPluginLifecycle_Unsafe.cfg` permits duplicate mount, service conflicts, spurious restart, and rollback loss. |

The safe configurations are small boundary models, not a full refinement proof. The host model now covers serialized ensure/reload/reset, service-conflict rejection, selective config reload, restart acknowledgement, and preserving the previous instance on replacement failure and restarting only when registration restoration fails; it does not claim transactional external plugin side effects. The other safe configurations map to the native owner-transition lock, replay continuity validation, and durable intent barrier.

## Run

Set `TLA2TOOLS_JAR` to the official `tla2tools.jar`, then run from the repository root:

```sh
bun run test:tla
```

The runner requires every safe configuration to exit 0 and every counterexample configuration to exit nonzero. It fails if a safe model unexpectedly passes its unsafe counterpart or if an expected counterexample is not found.

## Boundaries

- State spaces are deliberately small and are used for falsification and safety checks, not liveness or performance claims.
- Journal durability means process-crash recovery through write/flush, not `fsync` or power-loss durability.
- Intent ordering does not provide exactly-once external effects; it makes an unknown outcome recoverable.
- Lease safety covers cooperating owner-file transitions, not non-cooperating file writers or all shared-filesystem failures.
- Lean is not used for these asynchronous lifecycle properties.
