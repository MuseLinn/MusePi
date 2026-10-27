import type { FileLock, Process, ProcessWaitOptions } from "./index.js";

export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	filename: string;
	size?: number;
	filePath?: string;
}

export interface EmbeddedAddonArchive {
	format: "tar.gz";
	filename: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	files: EmbeddedAddonFile[];
	archive?: EmbeddedAddonArchive;
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;

export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	nativeDir: string;
	leafPackageDir?: string | null;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface InitLoaderContextOverrides {
	nativeDir?: string;
	platform?: NodeJS.Platform | string;
	isCompiledBinary?: boolean;
	leafPackageDir?: string | null;
}

export interface NativeLoaderContext {
	platformTag: string;
	packageVersion: string;
	nativeDir: string;
	leafPackageDir: string | null;
	versionedDir: string;
	isCompiledBinary: boolean;
	stageFromNodeModules: boolean;
	selectedVariant: "modern" | "baseline" | null;
	addonFilenames: string[];
	addonLabel: string;
	candidates: string[];
	versionSentinelExport: string;
	isWorkspaceLoad: boolean;
	nativesDir: string;
}

export function initLoaderContext(overrides?: InitLoaderContextOverrides): NativeLoaderContext;

export interface CleanupStaleNativeVersionsInput {
	nativesDir: string;
	currentVersion: string;
}

export function cleanupStaleNativeVersions(input: CleanupStaleNativeVersionsInput): string[];

export function prepareNativeVersionDir(versionedDir: string): void;

export interface ExtractEmbeddedAddonArchiveInput {
	archivePath: string;
	files: EmbeddedAddonFile[];
	targetDir: string;
}

export function extractEmbeddedAddonArchive(input: ExtractEmbeddedAddonArchiveInput): string[];

export interface SelectCpuVariantInput {
	arch: string;
	override: "modern" | "baseline" | null | undefined;
	env: Record<string, string | undefined>;
	detectAvx2: () => boolean;
}

export interface SelectCpuVariantResult {
	variant: "modern" | "baseline" | null;
	source: "non-x64" | "override" | "cache" | "detect";
	cacheEnvKey?: string;
	cacheEnvValue?: string;
}

export function selectCpuVariant(input: SelectCpuVariantInput): SelectCpuVariantResult;

export interface ValidateLoadedBindingsContext {
	isWorkspaceLoad: boolean;
	packageVersion: string;
	versionSentinelExport: string;
}

export function validateLoadedBindings(
	ctx: ValidateLoadedBindingsContext,
	bindings: Record<string, unknown>,
	candidate: string,
): void;

export function loadNative(): Record<string, unknown>;

/**
 * Try to acquire `path` without blocking, loading the native addon on first
 * use. Keep this subpath free of top-level `loadNative()` calls so worker
 * hosts and `--no-addons` CLI paths can import it without the addon.
 */
export declare function tryAcquireFileLock(path: string): FileLock;

/**
 * Open a stable process reference from a PID, loading the native addon on
 * first use. Keep this subpath free of top-level `loadNative()` calls so
 * worker hosts and `--no-addons` CLI paths can import it without the addon.
 */
export declare function processFromPid(pid: number): Process | null;

/** Whether the referenced pid is still running, loading the native addon on first use. */
export declare function isProcessRunning(pid: number): boolean;

/**
 * Wait until the referenced pid exits, loading the native addon on first
 * use. Resolves `true` when the process is already unobservable.
 */
export declare function waitForProcessExit(pid: number, options?: ProcessWaitOptions | undefined | null): Promise<boolean>;
