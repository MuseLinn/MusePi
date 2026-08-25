// ============================================================
// Terminal provider seam — explicit backend selection for daemon
// terminal.open RPC calls.
//
// Providers:
//   "bun-pty" — native Bun process (preferred, lowest latency)
//   "node-pty" — node-pty bridge subprocess (fallback, more portable)
//   "auto" — try bun-pty first, fall back to node-pty on failure
//            (default behavior matches existing code)
//
// When the manifest declares an explicit provider, that selection is
// followed strictly — bun-pty failure surfaces as a terminal error
// instead of silently falling back. This is the "avoid automatic
// fallback recovery" piece of the assembly design.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../config/settings.ts";

/** Explicit terminal backend selection. */
export type TerminalProvider = "bun-pty" | "node-pty" | "auto";

/** The handle returned to a daemon client for one open terminal. */
export interface TerminalHandle {
  /** Send input (data / resize / close). */
  write(data: string): void;
  /** Resize cols/rows. */
  resize(cols: number, rows: number): void;
  /** Kill the process and clean up. */
  dispose(): void;
  /** Exit code (once emitted). */
  onExit: (cb: (code: number | null) => void) => void;
  /** Raw data received. */
  onData: (cb: (data: string) => void) => void;
}

export interface TerminalProviderFactory {
  /** Resolve which provider to use given settings (and fallback). */
  resolve(settings: Settings): TerminalProvider;
  /** Spawn a terminal using this provider. */
  open(cwd: string, cols: number, rows: number, shell: string, shellArgs: string[], env: Record<string, string>): Promise<TerminalHandle>;
}

// ------------------------------------------------------------
// bun-pty provider
// ------------------------------------------------------------

async function spawnBunPty(
  cwd: string,
  cols: number,
  rows: number,
  shell: string,
  shellArgs: string[],
  env: Record<string, string>,
): Promise<TerminalHandle> {
  const { spawn } = await import("bun-pty") as unknown as {
    spawn(cmd: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }): TerminalHandle;
  };
  const proc = spawn(shell, shellArgs, { cols, rows, cwd, env });
  return proc;
}

// ------------------------------------------------------------
// node-pty bridge provider (runs via pty-bridge.cjs subprocess)
// ------------------------------------------------------------

async function spawnNodePtyBridge(
  cwd: string,
  cols: number,
  rows: number,
  shell: string,
  _shellArgs: string[],
  env: Record<string, string>,
): Promise<TerminalHandle> {
  // Bridge uses newline-delimited JSON over stdio with node-pty.
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const bridgePath = path.join(import.meta.dir, "pty-bridge.cjs");

  const nodeBin = await resolveNodeBinary();
  const child = spawn(nodeBin, [bridgePath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, COLUMNS: String(cols), LINES: String(rows) },
  }) as unknown as {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill(): void;
    on(event: "exit", cb: (code: number | null) => void): void;
    once(event: "error", cb: (err: Error) => void): void;
    off(event: "exit", cb: () => void): void;
  };

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }) as unknown as {
    on(event: "line", cb: (line: string) => void): void;
    once(event: "line", cb: (line: string) => void): void;
    close(): void;
  };

  return new Promise<TerminalHandle>((resolve, reject) => {
    let open = false;
    let exitSent = false;
    lines.on("line", (line: string) => {
      let msg: { kind?: string; id?: string; data?: string; code?: number; message?: string } | null = null;
      try { msg = JSON.parse(line); } catch { /* skip */ }
      if (!msg) return;
      if (msg.kind === "open") { open = true; }
      else if (msg.kind === "exit" && !exitSent) { exitSent = true; child.off("exit", () => {}); resolve({
        write(d: string) { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ method: "input", data: d })}\n`); },
        resize(c: number, r: number) { child.stdin.write(`${JSON.stringify({ method: "resize", cols: c, rows: r })}\n`); },
        dispose() { lines.close(); child.kill(); },
        onExit(cb) { child.on("exit", cb); },
        onData(cb) { lines.on("line", (l: string) => { try { const m = JSON.parse(l); if (m.kind === "data") cb(m.data ?? ""); } catch {} }); },
      }); }
      else if (msg.kind === "error") {
        reject(new Error(msg.message ?? "terminal bridge error"));
      }
    });
    child.once("error", (err: Error) => {
      if (!open) reject(err);
    });
    // Timeout fallback: if bridge doesn't open within 8s, fail.
    setTimeout(() => {
      if (!open && !exitSent) reject(new Error("terminal bridge spawn timeout"));
    }, 8000).unref?.();
  });
}

async function resolveNodeBinary(): Promise<string> {
  const { existsSync } = await import("node:fs");
  const candidates = [
    process.env.NODE_BINARY,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/opt/local/bin/node",
    "/usr/bin/node",
    "/usr/bin/env node",
  ].filter((c): c is string => typeof c === "string");
  for (const c of candidates) {
    if (c === "/usr/bin/env node") return c;
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return "node";
}

// ------------------------------------------------------------
// Provider registry
// ------------------------------------------------------------

const PROVIDERS: Record<TerminalProvider, TerminalProviderFactory> = {
  "bun-pty": {
    resolve(_settings): TerminalProvider { return "bun-pty"; },
    open: spawnBunPty,
  },
  "node-pty": {
    resolve(_settings): TerminalProvider { return "node-pty"; },
    open: spawnNodePtyBridge,
  },
  "auto": {
    resolve(settings: Settings): TerminalProvider {
      const raw = settings.getRaw("terminal.provider") as string | undefined;
      return raw === "bun-pty" ? "bun-pty" : raw === "node-pty" ? "node-pty" : "auto";
    },
    async open(cwd, cols, rows, shell, shellArgs, env) {
      // Try bun-pty first; on hard failure (ENOENT / module not found) fall back to node-pty.
      try {
        return await spawnBunPty(cwd, cols, rows, shell, shellArgs, env);
      } catch (err) {
        // Log but continue — auto is intended to degrade.
        console.warn(`[terminal] bun-pty failed (${String(err)}), falling back to node-pty`);
        return await spawnNodePtyBridge(cwd, cols, rows, shell, shellArgs, env);
      }
    },
  },
};

/**
 * Read the effective terminal provider from manifest + settings.
 *
 * Precedence (highest first):
 *   1. Manifest `[seams.terminal] provider`
 *   2. Settings `terminal.provider` (raw extension key)
 *   3. Defaults to "auto"
 */
export function resolveTerminalProvider(settings: Settings, manifestProvider?: TerminalProvider | null): TerminalProvider {
  if (manifestProvider) return manifestProvider;
  const raw = settings.getRaw("terminal.provider") as string | undefined;
  if (raw === "bun-pty" || raw === "node-pty") return raw;
  return "auto";
}

export function getTerminalProvider(name: TerminalProvider): TerminalProviderFactory {
  return PROVIDERS[name];
}

export function isTerminalProvider(value: unknown): value is TerminalProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
