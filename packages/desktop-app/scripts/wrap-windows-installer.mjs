import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const { buildBlockMap } = require(require.resolve("app-builder-lib/out/targets/blockmap/blockmap.js", {
	paths: [dirname(require.resolve("electron-builder/package.json"))],
}));

export async function wrapWindowsInstaller(artifactPath) {
	const source = resolve(artifactPath);
	if (!source.endsWith("-setup.exe") || !existsSync(source)) return null;
	if (!existsSync(CSC)) throw new Error(`Installer bootstrap compiler not found: ${CSC}`);

	const wrapped = `${source}.wrapped.exe`;
	execFileSync(
		CSC,
		[
			"/nologo",
			"/target:winexe",
			"/platform:x64",
			"/optimize+",
			`/out:${wrapped}`,
			`/win32manifest:${join(APP_DIR, "installer/InstallerHost.manifest")}`,
			`/win32icon:${join(APP_DIR, "build/icon.ico")}`,
			`/resource:${source},Payload`,
			"/r:System.Windows.Forms.dll",
			join(APP_DIR, "installer/InstallerBootstrap.cs"),
		],
		{ stdio: "inherit" },
	);
	copyFileSync(wrapped, source);
	const { size: wrappedSize } = statSync(source);
	const { size: bootstrapSize } = statSync(wrapped);
	if (wrappedSize !== bootstrapSize) throw new Error("Installer bootstrap replacement did not complete");

	const updateInfo = await buildBlockMap(source, "gzip", `${source}.blockmap`);
	const releaseDir = dirname(source);
	for (const name of readdirSync(releaseDir)) {
		if (!/^(?:latest|beta)(?:-win-(?:x64|arm64))?\.yml$/.test(name)) continue;
		const path = join(releaseDir, name);
		const yaml = readFileSync(path, "utf8")
			.replaceAll(/sha512: .*/g, `sha512: ${updateInfo.sha512}`)
			.replaceAll(/size: .*/g, `size: ${updateInfo.size}`);
		writeFileSync(path, yaml);
	}
	return source;
}

export default async function afterAllArtifactBuild(buildResult) {
	for (const artifact of buildResult.artifactPaths) await wrapWindowsInstaller(artifact);
	return [];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const artifact = process.argv[2];
	if (!artifact) throw new Error("Usage: bun scripts/wrap-windows-installer.mjs <path-to-setup.exe>");
	const wrapped = await wrapWindowsInstaller(artifact);
	if (wrapped) console.log(`[installer-bootstrap] wrapped ${wrapped}`);
}
