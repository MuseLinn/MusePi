/**
 * The memory-tools package: long-term memory tools as a capability package.
 *
 * Each tool is its own component so a deployment can ship the read side
 * (recall/reflect) without the write side, or drop the auto-learn capture tool
 * without touching memory at all. The tool classes still live in
 * `src/tools/memory-*.ts` — the package owns *whether* they mount, and the
 * provider seam makes a package the thing that supplies the implementation.
 */
import type { ExtensionAPI } from "../../extensibility/extensions/types";

export const name = "musepi-memory-tools";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: ExtensionAPI): void {
	// Components carry the per-tool registration; the package entry itself only
	// exists so discovery finds the directory and `musepi.components` mounts.
}
