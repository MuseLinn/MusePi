/** File tool families contributed by the file-tools Cordis package.
 *
 * Package and component fibers own availability. Read/write/search families
 * leave the session tool set when their component is unloaded; unloading the
 * index component stops background scans without changing existing FTS data.
 *
 * Ownership itself lives in `tool-ownership.ts` — this module is the file
 * domain's view of it, so the file families and every other packaged tool
 * answer "who owns this tool" from one table.
 */
import { isCapabilityActive } from "../extensibility/capability-activation";
import { isToolOwnerActive, TOOL_OWNERS } from "./tool-ownership";

export const FILE_BACKEND_COMPONENTS = ["read", "write", "search", "index"] as const;
export type FileBackendComponent = (typeof FILE_BACKEND_COMPONENTS)[number];

/** The file-tools component owning `name`, when the owner is in the file domain. */
export function fileBackendForTool(name: string): FileBackendComponent | null {
	const owner = TOOL_OWNERS[name];
	if (owner?.domain !== "file") return null;
	return FILE_BACKEND_COMPONENTS.includes(owner.id as FileBackendComponent)
		? (owner.id as FileBackendComponent)
		: null;
}

export function isFileBackendToolAllowed(name: string): boolean {
	return isToolOwnerActive(name);
}

export function isFileIndexBackendEnabled(): boolean {
	return isCapabilityActive("file", "index");
}
