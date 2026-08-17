import * as fs from "node:fs";
import path from "node:path";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";

/** Project type detection result */
interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

/** Convert a `go.work` use directory into the package pattern `go build` needs. */
function goWorkspaceBuildPattern(diskPath: string): string | null {
	const trimmed = diskPath.trim();
	if (!trimmed) return null;

	const isAbsolute = path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
	const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
	const dir = normalized || ".";
	if (dir === ".") return "./...";
	if (dir.endsWith("/...")) return dir;
	if (isAbsolute || dir.startsWith("./") || dir.startsWith("../")) return `${dir}/...`;
	return `./${dir}/...`;
}

/** Parse `go work edit -json` output into per-module package patterns. */
function parseGoWorkspaceBuildPatterns(output: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return [];
	}

	if (!parsed || typeof parsed !== "object" || !("Use" in parsed) || !Array.isArray(parsed.Use)) return [];

	const patterns = new Set<string>();
	for (const entry of parsed.Use) {
		if (!entry || typeof entry !== "object" || !("DiskPath" in entry) || typeof entry.DiskPath !== "string") {
			continue;
		}
		const pattern = goWorkspaceBuildPattern(entry.DiskPath);
		if (pattern) patterns.add(pattern);
	}
	return [...patterns];
}

/** Resolve the `go build` command for a `go.work` workspace. */
async function resolveGoWorkspaceDiagnosticsCommand(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const fallback = ["go", "build", "./..."];
	try {
		const proc = Bun.spawn(["go", "work", "edit", "-json"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const exitCode = await proc.exited;
			throwIfAborted(signal);
			if (exitCode !== 0) return fallback;
			const patterns = parseGoWorkspaceBuildPatterns(stdout);
			return patterns.length > 0 ? ["go", "build", ...patterns] : fallback;
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return fallback;
	}
}

/** Detect project type from root markers */
async function detectProjectType(cwd: string, signal?: AbortSignal): Promise<ProjectType> {
	// Check for Rust (Cargo.toml)
	if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}

	// Check for TypeScript (tsconfig.json)
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}

	// Check for Go workspaces before single-module Go projects.
	if (fs.existsSync(path.join(cwd, "go.work"))) {
		return {
			type: "go",
			command: await resolveGoWorkspaceDiagnosticsCommand(cwd, signal),
			description: "Go workspace (go build)",
		};
	}

	// Check for Go (go.mod)
	if (fs.existsSync(path.join(cwd, "go.mod"))) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}

	// Check for Python (pyproject.toml or pyrightconfig.json)
	if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}

	return { type: "unknown", description: "Unknown project type" };
}

/** Run workspace diagnostics command and parse output */
export async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = await detectProjectType(cwd, signal);
	if (!projectType.command) {
		return {
			output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml)`,
			projectType,
		};
	}
	try {
		const proc = Bun.spawn(projectType.command, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const abortHandler = () => {
			proc.kill();
		};
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			throwIfAborted(signal);
			const combined = (stdout + stderr).trim();
			if (!combined) {
				return { output: "No issues found", projectType };
			}
			// Limit output length
			const lines = combined.split("\n");
			if (lines.length > 50) {
				return { output: `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`, projectType };
			}
			return { output: combined, projectType };
		} finally {
			signal?.removeEventListener("abort", abortHandler);
		}
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	}
}
