// ============================================================
// Assembly — declarative product surface & seam config for musepi.
//
// A manifest file (musepi.assembly.toml) declares:
//   - which surface this session runs on (auto-detected from mode when absent)
//   - which extensions are "managed" (their load errors become session-fatal
//     unless degraded_ok; third-party extensions remain soft-fail/warn-visible)
//   - per-extension inclusion/exclusion filters (glob on extension id, path)
//   - seam defaults (terminal.provider, compaction method hint)
//
// This is a thin config layer over the existing extension discovery pipeline.
// It adds verifiable structure and fail-loud semantics without rewriting the
// core discovery or session machinery.
// ============================================================

import type { CompactionMethod } from "../session/compaction-methods.ts";

/** Product surface — maps roughly to the internal extension mode. */
export type Surface = "tui" | "daemon" | "headless" | "acp";

/** Terminal backend selection. */
export type TerminalProvider = "auto" | "bun-pty" | "node-pty";

/** Top-level parsed manifest (validated). */
export interface AssemblyManifest {
  /** Explicit surface; null = auto-detect from ctx.mode at boot. */
  surface: Surface | null;
  /**
   * Global fail-loud override for managed extension load errors.
   * false = fail on error; true = warn + visible in /assembly.
   * Default false (honor user intent: avoid silent degradation).
   */
  degradedOk: boolean;
  /**
   * Extensions declared as "managed" — the assembly owns them. Their
   * load errors are verified during boot.
   *
   * Keys are stable extension ids (derived from source path via
   * extensionIdOf). The value holds optional per-extension filters.
   */
  extensions: ManifestExtensions;
  /**
   * Seams: swappable core implementations, selected here or overridden
   * via settings (settings wins).
   */
  seams: ManifestSeams;
}

export interface ManifestExtensions {
  /** Explicitly enabled extension ids (overrides discovery). When set,
   * only these ids are considered from discovered paths. */
  include?: string[];
  /** Extension ids explicitly excluded (in addition to settings.disabledExtensions). */
  exclude?: string[];
  /** Per-extension knobs. */
  items?: Record<string, ManifestExtensionItem>;
  /** Path glob overrides. Empty = disable glob filtering (id-only matching). */
  patterns?: string[];
}

export interface ManifestExtensionItem {
  /** True = forced enable; false = forced disable (overrides include/exclude). */
  enabled?: boolean;
}

export interface ManifestSeams {
  /** Terminal provider selection. */
  terminal?: { provider?: TerminalProvider };
  /** Preferred compaction method (hint; validated against known methods). */
  compaction?: { method?: CompactionMethod };
}

/** Validation result of a manifest parse. Errors are fatal config issues. */
export interface AssemblyManifestValidateResult {
  valid: boolean;
  errors: Array<{ key: string; message: string }>;
  manifest: AssemblyManifest | null;
}

/** A verified extension load error report per extension. */
export interface AssemblyExtensionError {
  id: string;
  path: string;
  error: string;
}

/** Verification outcome for a session's extension load result. */
export interface AssemblyVerifyReport {
  ok: boolean;
  /** Fail-loud issues (managed ext load errors when degraded_ok=false). */
  fatalIssues: AssemblyExtensionError[];
  /** Warnings (unmanaged or degraded issues). */
  warnings: AssemblyExtensionError[];
  /** Manifest source path for display. */
  manifestPath: string | null;
  surface: Surface;
  /** Managed extension ids that were active. */
  managedIds: Set<string>;
}

/** Session-level assembly state (read by /assembly command). */
export interface AssemblySessionState {
  manifest: AssemblyManifest | null;
  manifestPath: string | null;
  surface: Surface;
  lastVerify: AssemblyVerifyReport | null;
}
