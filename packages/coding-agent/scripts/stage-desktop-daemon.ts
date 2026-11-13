#!/usr/bin/env bun
/** Stage the desktop daemon and self-contained first-party plugin packages. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePluginComponents } from "@musepi/pi-wire";
import { compileComponentModule } from "../src/daemon/extension-artifact-compiler";

export interface StageDaemonOptions {
	readonly binaryPath: string;
	readonly repoRoot: string;
	readonly outputDir: string;
}

interface PluginManifest {
	readonly musepi?: { extensions?: unknown; components?: unknown };
	readonly [key: string]: unknown;
}

async function readManifest(packageDir: string): Promise<PluginManifest> {
	return (await Bun.file(path.join(packageDir, "package.json")).json()) as PluginManifest;
}

function declaredEntries(manifest: PluginManifest, name: string): string[] {
	const declared = manifest.musepi?.extensions;
	if (!Array.isArray(declared) || declared.length === 0) {
		throw new Error(`Bundled plugin ${name} has no musepi.extensions entries`);
	}
	for (const entry of declared) {
		if (typeof entry !== "string" || entry.length === 0) {
			throw new Error(`Bundled plugin ${name} has an invalid extension entry`);
		}
	}
	return declared as string[];
}

/** Flatten the per-module reasons Bun buries inside an AggregateError. */
function buildErrorDetail(error: unknown): string {
	const nested = (error as { errors?: unknown[] }).errors;
	if (Array.isArray(nested) && nested.length > 0) {
		return nested.map(entry => (entry instanceof Error ? entry.message : String(entry))).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

async function bundleEntry(source: string, destination: string): Promise<void> {
	await fs.stat(source);
	let result: Awaited<ReturnType<typeof Bun.build>>;
	try {
		result = await Bun.build({
			entrypoints: [source],
			target: "bun",
			format: "esm",
			// Plain JavaScript dependencies must travel with each staged plugin:
			// the installed vendor directory has no repository node_modules above
			// it. Only native/heavy runtimes stay external to the desktop package.
			external: [
				"@musepi/pi-natives",
				"@huggingface/transformers",
				"bun-pty",
				"fastembed",
				"node-pty",
				"omp-legacy-pi-modules",
				"onnxruntime-node",
				"puppeteer-core",
				"sherpa-onnx-node",
			],
			minify: true,
			plugins: [
				{
					name: "musepi-first-party-host-modules",
					setup(build) {
						build.onResolve({ filter: /^\.\.\/\.\.\/modes\/(orchestrate|ultrathink|workflow)$/ }, args => ({
							path: `@musepi/pi-coding-agent/modes/${args.path.split("/").at(-1)}`,
							external: true,
						}));
					},
				},
			],
		});
	} catch (error) {
		// Bun throws an AggregateError whose message is only "Bundle failed";
		// the per-module reasons live in `errors`. Stage failures are what the
		// desktop release dies on, so surface them instead of the wrapper text.
		throw new Error(`Failed to bundle ${source}: ${buildErrorDetail(error)}`);
	}
	const output = result.outputs.find(candidate => candidate.kind === "entry-point");
	if (!result.success || !output) {
		throw new Error(`Failed to bundle ${source}: ${result.logs.map(log => log.message).join("; ")}`);
	}
	let code = await output.text();
	for (const match of (await Bun.file(source).text()).matchAll(
		/moduleUrl\s*:\s*["'](\.[^"']+\.(?:tsx|jsx|ts))["']/g,
	)) {
		const compiled = match[1].replace(/\.(?:tsx|jsx|ts)$/, ".js");
		code = code.replaceAll(`"${match[1]}"`, `"${compiled}"`).replaceAll(`'${match[1]}'`, `'${compiled}'`);
	}
	await Bun.write(destination, code);
}

function javascriptEntry(entry: string): string {
	return entry.replace(/\.(?:tsx|jsx|ts)$/, ".js");
}

async function stagePlugin(sourceDir: string, destinationDir: string): Promise<void> {
	const name = path.basename(sourceDir);
	const manifest = await readManifest(sourceDir);
	// File skills are runtime resources, not imports in the bundled entry.
	// Ship the complete skill directories so staged discovery matches dev.
	const skillsSource = path.join(sourceDir, "skills");
	const skillsStat = await fs.stat(skillsSource).catch(() => null);
	if (skillsStat?.isDirectory()) {
		await fs.cp(skillsSource, path.join(destinationDir, "skills"), { recursive: true });
	}
	const entries = declaredEntries(manifest, name);
	const declaredComponents = parsePluginComponents(manifest.musepi?.components).components;
	const entryFiles = new Set([
		...entries,
		...declaredComponents.flatMap(component => (component.entry ? [component.entry] : [])),
	]);
	const rendererModules = new Set<string>();
	for (const entry of entryFiles) {
		const source = path.resolve(sourceDir, entry);
		const destination = path.resolve(destinationDir, javascriptEntry(entry));
		await bundleEntry(source, destination);
		const sourceText = await Bun.file(source).text();
		for (const match of sourceText.matchAll(/moduleUrl\s*:\s*["'](\.[^"']+\.(?:tsx|jsx|ts))["']/g)) {
			rendererModules.add(match[1]);
		}
	}
	for (const component of rendererModules) {
		const source = path.resolve(sourceDir, component);
		const destination = path.resolve(destinationDir, javascriptEntry(component));
		const compiled = await compileComponentModule(source);
		await Bun.write(destination, compiled.code);
		if (compiled.css) await Bun.write(destination.replace(/\.js$/, ".css"), compiled.css);
	}
	const stagedManifest = {
		...manifest,
		musepi: {
			...manifest.musepi,
			extensions: entries.map(javascriptEntry),
			components: Array.isArray(manifest.musepi?.components)
				? manifest.musepi.components.map((component: unknown) => {
						if (!component || typeof component !== "object" || Array.isArray(component)) return component;
						const entry = (component as { entry?: unknown }).entry;
						return typeof entry === "string" ? { ...component, entry: javascriptEntry(entry) } : component;
					})
				: manifest.musepi?.components,
		},
	};
	await Bun.write(path.join(destinationDir, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`);
}

/** Copy the exact runtime layout consumed by MUSEPI_BUNDLED_PLUGIN_ROOTS. */
export async function stageDaemon(options: StageDaemonOptions): Promise<void> {
	const codingAgentRoot = path.join(options.repoRoot, "packages", "coding-agent");
	const packageRoot = path.join(options.repoRoot, "packages", "desktop-app");
	const pluginTrees = [
		{
			source: path.join(codingAgentRoot, "src", "bundled-plugins"),
			destination: path.join(options.outputDir, "bundled-plugins"),
		},
		{
			source: path.join(packageRoot, "src", "plugins"),
			destination: path.join(options.outputDir, "desktop-plugins"),
		},
	];
	await fs.mkdir(options.outputDir, { recursive: true });
	await fs.copyFile(options.binaryPath, path.join(options.outputDir, path.basename(options.binaryPath)));
	for (const tree of pluginTrees) {
		const entries = await fs.readdir(tree.source, { withFileTypes: true });
		const packages = entries.filter(entry => entry.isDirectory());
		if (packages.length === 0) throw new Error(`No bundled plugin packages found in ${tree.source}`);
		await fs.rm(tree.destination, { recursive: true, force: true });
		for (const entry of packages) {
			await stagePlugin(path.join(tree.source, entry.name), path.join(tree.destination, entry.name));
		}
	}
	for (const packageName of ["bun-pty", "node-pty"]) {
		const sourceDir = path.dirname(Bun.resolveSync(`${packageName}/package.json`, codingAgentRoot));
		const destinationDir = path.join(options.outputDir, "node_modules", packageName);
		await fs.rm(destinationDir, { recursive: true, force: true });
		await fs.cp(sourceDir, destinationDir, { recursive: true });
	}
	const bridgeDestination = path.join(options.outputDir, "bundled-plugins", "terminal", "pty-bridge.cjs");
	await fs.mkdir(path.dirname(bridgeDestination), { recursive: true });
	await fs.copyFile(path.join(codingAgentRoot, "src", "daemon", "pty-bridge.cjs"), bridgeDestination);
}

async function main(): Promise<void> {
	const repoRoot = path.resolve(import.meta.dir, "../../..");
	const binaryFlag = process.argv.indexOf("--binary");
	const outputFlag = process.argv.indexOf("--out");
	if (binaryFlag < 0 || !process.argv[binaryFlag + 1]) {
		throw new Error("Usage: bun scripts/stage-desktop-daemon.ts --binary <path> [--out <directory>]");
	}
	const outputDir = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
	await stageDaemon({
		binaryPath: path.resolve(process.argv[binaryFlag + 1]),
		repoRoot,
		outputDir: outputDir
			? path.resolve(outputDir)
			: path.join(repoRoot, "packages", "desktop-app", "vendor", "daemon"),
	});
	process.stdout.write("Staged daemon with bundled-plugins and desktop-plugins\n");
}

if (import.meta.main) await main();
