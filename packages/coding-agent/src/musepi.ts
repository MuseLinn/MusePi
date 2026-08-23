#!/usr/bin/env bun
// MusePi CLI entry point
// Sets version before delegating to the CLI.

import pkg from "../package.json" with { type: "json" };

process.env.MUSEPI_VERSION = pkg.version;

const { runCli } = await import("./cli.ts");
// `process.argv` is [bun, script-path, ...args]; drop both before delegating
// (mirrors the `slice(2)` in cli.ts's own process-entry guard).
await runCli(process.argv.slice(2));
