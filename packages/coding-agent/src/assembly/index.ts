// ============================================================
// Assembly — top-level API for the musepi assembly system.
//
// Single global session state (AssemblySessionState) is shared between
// the CLI (musepi assembly *), the daemon (for surface/manifest display),
// and the runRootCommand path (for boot-time verification).
//
// Surface detection maps the internal mode value to a Surface:
//   "tui"           → tui   (isInteractive)
//   "rpc-ui"        → daemon (hasUI from the GUI)
//   "rpc" / "acp"   → headless
//   "print" / "json"/default print-like → headless
// ============================================================

import * as os from "node:os";
import * as path from "node:path";
import { loadAssemblyManifest } from "./manifest.ts";
import type {
  AssemblyManifest,
  AssemblyVerifyReport,
  Surface,
  TerminalProvider,
} from "./types.ts";
import { verifyExtensionLoad, AssemblyVerifyError } from "./verify.ts";

export {
  AssemblyManifestError,
} from "./manifest.ts";
export type {
  AssemblyManifest,
  AssemblyVerifyReport,
  AssemblyExtensionError,
  Surface,
  TerminalProvider,
} from "./types.ts";
export {
  getSessionState,
  filterExtensionPaths,
  AssemblyVerifyError,
} from "./verify.ts";

export const ASSEMBLY_MANIFEST_FILENAME = "assembly.toml";
const ASSEMBLY_DIR = ".musepi";

export interface AssemblyLoadResult {
  manifest: AssemblyManifest | null;
  manifestPath: string | null;
  surface: Surface;
  /** true if no manifest was found (defaults apply). */
  noManifest: boolean;
}

/**
 * Surface from the internal mode string. Used by both main.ts and the
 * daemon when no explicit surface is declared in the manifest.
 */
export function surfaceFromMode(mode: string | undefined, hasUI: boolean | undefined): Surface {
  if (!mode) return "tui"; // interactive default
  switch (mode) {
    case "rpc-ui":
      return hasUI ? "daemon" : "headless";
    case "rpc":
    case "acp":
      return "headless";
    case "print":
    case "json":
      return "headless";
    case "tui":
      return "tui";
    default:
      return "headless";
  }
}

export class AssemblySessionState {
  private _manifest: AssemblyManifest | null = null;
  private _manifestPath: string | null = null;
  private _surface: Surface = "headless";
  private _lastVerify: AssemblyVerifyReport | null = null;

  get manifest(): AssemblyManifest | null { return this._manifest; }
  get manifestPath(): string | null { return this._manifestPath; }
  get surface(): Surface { return this._surface; }
  get lastVerify(): AssemblyVerifyReport | null { return this._lastVerify; }

  set(state: {
    manifest?: AssemblyManifest | null;
    manifestPath?: string | null;
    surface?: Surface;
    lastVerify?: AssemblyVerifyReport | null;
  }): void {
    if (state.manifest !== undefined) this._manifest = state.manifest;
    if (state.manifestPath !== undefined) this._manifestPath = state.manifestPath;
    if (state.surface !== undefined) this._surface = state.surface;
    if (state.lastVerify !== undefined) this._lastVerify = state.lastVerify;
  }
}

/** Global session state — shared by CLI commands, daemon, and boot path. */
export const assemblySessionState = new AssemblySessionState();

/**
 * Load the assembly manifest for the given cwd/home. Returns null when
 * no manifest file is found anywhere.
 */
export async function loadAssembly(
  cwd: string,
  home: string = os.homedir(),
): Promise<AssemblyLoadResult> {
  const manifest = await loadAssemblyManifest(cwd, home);
  const manifestPath = manifest
    ? findResolvedManifestPath(cwd, home)
    : null;
  return { manifest, manifestPath, surface: "headless", noManifest: manifest === null };
}

function findResolvedManifestPath(cwd: string, home: string): string | null {
  const project = path.join(cwd, ASSEMBLY_DIR, ASSEMBLY_MANIFEST_FILENAME);
  if (fsSync.existsSync(project)) return project;
  const agentDir = getCachedAgentDir();
  if (agentDir) {
    const agentPath = path.join(agentDir, ASSEMBLY_MANIFEST_FILENAME);
    if (fsSync.existsSync(agentPath)) return agentPath;
  }
  const user = path.join(home, ASSEMBLY_DIR, ASSEMBLY_MANIFEST_FILENAME);
  if (fsSync.existsSync(user)) return user;
  return null;
}

function getCachedAgentDir(): string | null {
  return null;
}

import * as fsSync from "node:fs";

/**
 * Verify an extension load result against the assembly manifest.
 * When fatal issues exist and degraded_ok=false, throws
 * AssemblyVerifyError so the caller can fail loud at boot.
 */
export async function bootVerifyExtensions(
  cwd: string,
  home: string,
  surface: Surface,
  result: { extensions: any[]; errors: Array<{ path: string; error: string }> },
): Promise<void> {
  const manifest = await loadAssemblySync(cwd, home);
  const report = verifyExtensionLoad(result as any, manifest, surface);
  assemblySessionState.set({
    manifest,
    manifestPath: manifest ? findResolvedManifestPath(cwd, home) : null,
    surface,
    lastVerify: report,
  });
  if (!report.ok && !manifest?.degradedOk) {
    throw new AssemblyVerifyError(report, report.manifestPath);
  }
}

async function loadAssemblySync(cwd: string, home: string): Promise<AssemblyManifest | null> {
  try {
    return await loadAssemblyManifest(cwd, home);
  } catch {
    return null;
  }
}

/**
 * Compute assembly status rows for the `musepi assembly status` output.
 */
export function buildAssemblyStatusRows(): string[] {
  const state = assemblySessionState;
  const rows: string[] = [];
  rows.push(`surface: ${state.surface}`);
  rows.push(`manifest: ${state.manifestPath ?? "(none — defaults: all capabilities enabled)"}`);
  const mft = state.manifest;
  if (mft) {
    rows.push(`degraded_ok: ${mft.degradedOk}`);
    if (mft.seams.terminal?.provider) rows.push(`terminal.provider: ${mft.seams.terminal.provider}`);
    if (mft.seams.compaction?.method) rows.push(`compaction.method: ${mft.seams.compaction.method}`);
    const ext = mft.extensions;
    if (ext.include && ext.include.length > 0) rows.push(`extensions.include: [${ext.include.join(", ")}]`);
    if (ext.exclude && ext.exclude.length > 0) rows.push(`extensions.exclude: [${ext.exclude.join(", ")}]`);
  } else {
    rows.push("no manifest — all extensions unmanaged (soft-fail)");
  }
  const verify = state.lastVerify;
  if (!verify) {
    rows.push("boot: not yet verified");
  } else {
    const nFatal = verify.fatalIssues.length;
    const nWarn = verify.warnings.length;
    rows.push(`boot: ${verify.ok ? "OK" : `FAILED (${nFatal} managed error(s), ${nWarn} warning(s))`}`);
    for (const e of verify.fatalIssues) {
      rows.push(`  [MANAGED ERROR] ${e.id} @ ${e.path}`);
      rows.push(`    ${e.error.split("\n")[0]}`);
    }
    for (const e of verify.warnings.slice(0, 5)) {
      rows.push(`  [WARN] ${e.id} @ ${e.path}`);
    }
    if (verify.warnings.length > 5) {
      rows.push(`  ... and ${verify.warnings.length - 5} more warning(s) — run musepi assembly verify`);
    }
  }
  return rows;
}
