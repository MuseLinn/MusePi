#!/usr/bin/env bun
// MusePi CLI entry point
// Sets version before delegating to the CLI.

// Override version display
process.env.MUSEPI_VERSION = "0.4.3";

// Import and run the CLI
const { runCli } = await import("./cli.ts");
await runCli(process.argv.slice(2));
