#!/usr/bin/env bun
// MusePi CLI entry point
// Sets version before delegating to the CLI.

import pkg from "../package.json" with { type: "json" };

process.env.MUSEPI_VERSION = pkg.version;

const { runCli } = await import("./cli.ts");
await runCli(process.argv.slice(1));
