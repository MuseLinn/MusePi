import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readPluginBlock } from "../extensibility/plugins/profile/manifest-block";
import { resolvePluginManifestEntries } from "../extensibility/plugins/runtime/loader";
import type { InstalledPlugin, PluginManifest } from "../extensibility/plugins/runtime/types";

export interface PackedPlugin {
	readonly name: string;
	readonly version: string;
	readonly filename: string;
	readonly path: string;
}

interface PluginPackageJson {
	name?: string;
	version?: string;
	musepi?: PluginManifest;
	omp?: PluginManifest;
	pi?: PluginManifest;
}

/** Create an installable tarball without contacting a registry or running publish. */
export async function packPlugin(packagePath: string, outputPath?: string): Promise<PackedPlugin> {
	const packageDir = path.resolve(packagePath);
	const pkg = (await Bun.file(path.join(packageDir, "package.json")).json()) as PluginPackageJson;
	if (typeof pkg.name !== "string" || pkg.name.length === 0) {
		throw new Error("Plugin package.json must have a name");
	}
	if (typeof pkg.version !== "string" || pkg.version.length === 0) {
		throw new Error(`Plugin ${pkg.name} package.json must have a version`);
	}
	const manifest = readPluginBlock(pkg) as PluginManifest | undefined;
	if (!manifest) {
		throw new Error(`Plugin ${pkg.name} must declare a musepi, omp, or pi manifest block`);
	}
	const candidate: InstalledPlugin = {
		name: pkg.name,
		version: pkg.version,
		path: packageDir,
		manifest,
		enabledFeatures: null,
		enabled: true,
	};
	const missing = resolvePluginManifestEntries(candidate, "extensions")
		.filter(entry => entry.resolvedPath === null)
		.map(entry => entry.entry);
	if (missing.length > 0) {
		throw new Error(`Plugin ${pkg.name} has missing extension entries: ${missing.join(", ")}`);
	}

	const destination = path.resolve(outputPath ?? packageDir);
	await fs.mkdir(destination, { recursive: true });
	const proc = Bun.spawn(["bun", "pm", "pack", "--quiet", "--destination", destination], {
		cwd: packageDir,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`bun pm pack failed: ${stderr.trim() || stdout.trim() || `exit code ${exitCode}`}`);
	}
	const reportedPath = stdout.trim().split(/\r?\n/).at(-1) ?? "";
	if (reportedPath === "" || !reportedPath.endsWith(".tgz")) {
		throw new Error(`bun pm pack returned an invalid tarball path: ${JSON.stringify(stdout.trim())}`);
	}
	// Bun 1.4 reports an absolute path; older versions reported only the filename.
	const tarballPath = path.isAbsolute(reportedPath)
		? path.normalize(reportedPath)
		: path.join(destination, reportedPath);
	if (!(await Bun.file(tarballPath).exists())) {
		throw new Error(`bun pm pack did not create ${tarballPath}`);
	}
	return { name: pkg.name, version: pkg.version, filename: path.basename(tarballPath), path: tarballPath };
}
