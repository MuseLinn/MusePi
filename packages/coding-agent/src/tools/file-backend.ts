/** File tool families contributed by the file-tools Cordis package.
 *
 * Package and component fibers own availability. Read/write/search families
 * leave the session tool set when their component is unloaded; unloading the
 * index component stops background scans without changing existing FTS data. */
import { isCapabilityActive } from "../extensibility/capability-activation";

export const FILE_BACKEND_COMPONENTS = ["read", "write", "search", "index"] as const;
export type FileBackendComponent = (typeof FILE_BACKEND_COMPONENTS)[number];

const FILE_TOOL_BACKENDS: Record<string, FileBackendComponent> = {
	read: "read",
	write: "write",
	edit: "write",
	ast_edit: "write",
	glob: "search",
	grep: "search",
	ast_grep: "search",
};

export function fileBackendForTool(name: string): FileBackendComponent | null {
	return FILE_TOOL_BACKENDS[name] ?? null;
}

export function isFileBackendToolAllowed(name: string): boolean {
	const backend = fileBackendForTool(name);
	return backend === null || isCapabilityActive("file", backend);
}

export function isFileIndexBackendEnabled(): boolean {
	return isCapabilityActive("file", "index");
}
