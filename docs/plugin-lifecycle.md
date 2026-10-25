---
layout: default
title: Plugin lifecycle and ownership
status: living
summary: Cordis plugin registration, consumption, state, dependencies, disposal, and the boundary with native services.
scope:
  - packages/coding-agent/src/bundled-plugins
  - packages/coding-agent/src/extensibility/plugins/runtime
  - packages/coding-agent/src/daemon/cordis-dynamic-plugins.ts
---

# Plugin lifecycle and ownership

English | [中文](plugin-lifecycle.zh-CN.md)

MusePi plugins own both registration and consumption. A package is not fully migrated when it only appears in the extension center while a static host path still performs the feature. Native configuration discovery and core domain services are not automatically plugin debt.

## Ownership boundary

| Form | Meaning and lifecycle |
| --- | --- |
| Cordis plugin package | A mounted fiber owns registrations, published services, state, and cleanup. `src/bundled-plugins` contains first-party examples. |
| Legacy extension | Uses the `pi.*` compatibility façade without Cordis-only primitives. It keeps legacy loading semantics and does not receive `pi.effect` or `pi.state`. |
| Native configuration provider | Reads user/project configuration into a capability list. This is discovery, not a plugin fiber, and has no independent start/stop lifecycle. |
| Core domain service | Owns session, model, persistence, protocol, or other invariants required for the host to work. Do not wrap it merely to make the plugin list look larger. |

`omp-plugins` and `musepi-extensions` remain distinct providers. New first-party replaceable capabilities use `musepi-extensions`; they do not become `native` merely because they ship with the app.

## Mount and consumption

A complete migration has four parts:

1. **Declaration**: the package exports its identity and `apply`, plus `inject`/`provide` when dependencies exist.
2. **Registration**: `register*` calls attach the feature to its actual registry or slot.
3. **Consumption**: prompt generation, UI rendering, commands, and other consumers read that registry rather than a parallel static implementation.
4. **Disposal**: unloading removes the registrations and their visible/runtime effects.

`magic-keywords` follows all four: the package contributes notice templates and gradients, `AgentSession` builds notices through the registry, and editor highlighting uses only registered highlighters. An empty registry therefore means no notice and no highlight. `stats-pills` owns the composer dock component through the same slot lifecycle.

## Side effects and state

Use `pi.effect(cleanup, label?)` for timers, watchers, sockets, abort controllers, and other resources not covered by a `register*` disposer. Cleanups run in reverse order on unload and rollback; one failure does not stop the others.

Use `pi.state` for fiber-scoped values. It supports `get`, `set`, `has`, `delete`, and `keys`, remains readable during cleanup, and is cleared after disposal. Do not use module-level variables or `globalThis` as a substitute for fiber state: re-evaluation creates a different module instance and splits ownership.

`pi.effect` and `pi.state` exist only on the Cordis API. They are attached by `plugins/runtime/mount.ts` and keyed by the mounted `Extension`, not added to the legacy API façade.

## Dependencies

Declare `inject` for required services and return published objects under their `provide` names. Mounting refuses a plugin when a required provider is absent. Consumers call `pi.service(name)` and handle a provider disappearing at runtime.

The registry publishes a service only after a successful mount and removes it on unload. This prevents consumers from capturing a service whose provider failed or has already gone away.

First mount shares the process module instance; explicit reload re-evaluates the entry and its graph. Registration state and fiber state belong to the mounted `Extension`, not to the module object.

## Host and session domains

Host-level plugins live under `musepi-dynamic-plugins` in `daemon/cordis-dynamic-plugins.ts`. They support inspection, independent component fibers, RPC dispatch, enable/disable, reload, and unload. Session-level loading uses the session extension context. Do not share a host singleton as an implicit session service.

A component declared in `musepi.components` has its own fiber when it has an entry. Its state can be `active`, `disabled`, `failed`, or `unloaded`; declarations remain inspectable after the plugin is disabled.

## Migration checklist

- Name the authoritative registry, consumer, activation owner, and disposal owner.
- Move consumers to the plugin registry before deleting any static fallback.
- Preserve the previous model-visible and UI behavior while removing duplicate paths.
- Verify disabled and empty-registry behavior, not only loaded behavior.
- Verify reload, repeated mount, provider disappearance, and cleanup failure isolation.
- Update `docs/extensions-dev.md` and this guide for API or lifecycle changes.
