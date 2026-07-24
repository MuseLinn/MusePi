import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyStagedUpdatePosix,
	backupDirName,
	buildWindowsUpdateScript,
	cleanupStaleUpdateDirs,
	detectInstallDir,
	executableNameForPlatform,
	extractReleaseArchive,
	findInstallRoot,
	getReleaseAssetName,
	isDirectoryWritable,
	resolveAssetDownload,
	stagedDirName,
	stageInstallRoot,
	validateInstallRoot,
} from "../src/utils/self-update.ts";

let workRoot: string;

beforeEach(() => {
	workRoot = mkdtempSync(join(tmpdir(), "musepi-self-update-test-"));
});

afterEach(() => {
	rmSync(workRoot, { recursive: true, force: true });
});

function makeInstallDir(dir: string, options: { version?: string; platform?: NodeJS.Platform } = {}): string {
	mkdirSync(dir, { recursive: true });
	const exe = executableNameForPlatform(options.platform ?? "linux");
	writeFileSync(join(dir, exe), "fake-binary");
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: "@muselinn/musepi",
			version: options.version ?? "0.1.1",
			piConfig: { name: "musepi" },
		}),
	);
	mkdirSync(join(dir, "theme"), { recursive: true });
	writeFileSync(join(dir, "theme", "dark.json"), "{}");
	return dir;
}

describe("platform -> asset name mapping", () => {
	it("maps every supported platform/arch to its release archive", () => {
		expect(getReleaseAssetName("win32", "x64")).toBe("musepi-windows-x64.zip");
		expect(getReleaseAssetName("win32", "arm64")).toBe("musepi-windows-arm64.zip");
		expect(getReleaseAssetName("linux", "x64")).toBe("musepi-linux-x64.tar.gz");
		expect(getReleaseAssetName("linux", "arm64")).toBe("musepi-linux-arm64.tar.gz");
		expect(getReleaseAssetName("darwin", "x64")).toBe("musepi-darwin-x64.tar.gz");
		expect(getReleaseAssetName("darwin", "arm64")).toBe("musepi-darwin-arm64.tar.gz");
	});

	it("returns undefined for unsupported platforms", () => {
		expect(getReleaseAssetName("freebsd", "x64")).toBeUndefined();
		expect(getReleaseAssetName("linux", "ia32")).toBeUndefined();
	});
});

describe("resolveAssetDownload", () => {
	it("prefers the asset URL reported by the releases api", () => {
		const download = resolveAssetDownload(
			{
				version: "0.2.0",
				assets: [{ name: "musepi-linux-x64.tar.gz", url: "https://example.com/musepi-linux-x64.tar.gz" }],
			},
			"linux",
			"x64",
		);
		expect(download).toEqual({
			assetName: "musepi-linux-x64.tar.gz",
			url: "https://example.com/musepi-linux-x64.tar.gz",
		});
	});

	it("falls back to the conventional download URL when assets are missing", () => {
		const download = resolveAssetDownload({ version: "0.2.0" }, "win32", "arm64");
		expect(download).toEqual({
			assetName: "musepi-windows-arm64.zip",
			url: "https://github.com/MuseLinn/MusePi/releases/download/v0.2.0/musepi-windows-arm64.zip",
		});
	});

	it("returns undefined for unsupported platforms", () => {
		expect(resolveAssetDownload({ version: "0.2.0" }, "freebsd", "x64")).toBeUndefined();
	});
});

describe("validateInstallRoot", () => {
	it("accepts a directory with the executable and a musepi package.json", () => {
		const dir = makeInstallDir(join(workRoot, "musepi"), { version: "0.1.1" });
		expect(validateInstallRoot(dir, "linux")).toEqual({ valid: true, version: "0.1.1" });
	});

	it("rejects a directory without the executable", () => {
		const dir = join(workRoot, "no-exe");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ piConfig: { name: "musepi" } }));
		const result = validateInstallRoot(dir, "linux");
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("musepi");
	});

	it("rejects a directory without package.json", () => {
		const dir = join(workRoot, "no-pkg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "musepi"), "fake-binary");
		expect(validateInstallRoot(dir, "linux").valid).toBe(false);
	});

	it("rejects archives that are not MusePi (piConfig.name guard)", () => {
		const dir = join(workRoot, "stock-pi");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "musepi"), "fake-binary");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ piConfig: { name: "pi" } }));
		const result = validateInstallRoot(dir, "linux");
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("piConfig.name");
	});

	it("rejects broken package.json files", () => {
		const dir = join(workRoot, "broken-json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "musepi"), "fake-binary");
		writeFileSync(join(dir, "package.json"), "{not json");
		expect(validateInstallRoot(dir, "linux").valid).toBe(false);
	});

	it("checks for musepi.exe on windows", () => {
		const dir = join(workRoot, "win");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "musepi"), "fake-binary");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ piConfig: { name: "musepi" } }));
		expect(validateInstallRoot(dir, "win32").valid).toBe(false);
		writeFileSync(join(dir, "musepi.exe"), "fake-binary");
		expect(validateInstallRoot(dir, "win32").valid).toBe(true);
	});
});

describe("findInstallRoot", () => {
	it("finds the install at the archive root (zip layout)", () => {
		const extractDir = makeInstallDir(join(workRoot, "zip-extract"));
		expect(findInstallRoot(extractDir, "win32")).toBeUndefined(); // no musepi.exe yet
		writeFileSync(join(extractDir, "musepi.exe"), "fake-binary");
		expect(findInstallRoot(extractDir, "win32")).toBe(extractDir);
	});

	it("finds the install inside the musepi/ wrapper (tar.gz layout)", () => {
		const extractDir = join(workRoot, "tar-extract");
		makeInstallDir(join(extractDir, "musepi"));
		expect(findInstallRoot(extractDir, "linux")).toBe(join(extractDir, "musepi"));
	});

	it("returns undefined when nothing validates", () => {
		const extractDir = join(workRoot, "empty-extract");
		mkdirSync(join(extractDir, "random"), { recursive: true });
		expect(findInstallRoot(extractDir, "linux")).toBeUndefined();
	});
});

describe("install dir detection and writability", () => {
	it("detects the install dir from the executable path", () => {
		const dir = makeInstallDir(join(workRoot, "musepi"));
		expect(detectInstallDir(join(dir, "musepi"), "linux")).toBe(dir);
	});

	it("refuses directories that are not musepi installs", () => {
		const dir = join(workRoot, "not-musepi");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "musepi"), "fake-binary");
		expect(detectInstallDir(join(dir, "musepi"), "linux")).toBeUndefined();
	});

	it("reports writable and non-writable directories", () => {
		expect(isDirectoryWritable(workRoot)).toBe(true);
		expect(isDirectoryWritable(join(workRoot, "does-not-exist", "at-all"))).toBe(false);
	});
});

describe("stale backup cleanup", () => {
	it("removes only musepi.old-*/new-* siblings", () => {
		const parent = join(workRoot, "apps");
		const installDir = makeInstallDir(join(parent, "musepi"));
		mkdirSync(join(parent, "musepi.old-1"), { recursive: true });
		mkdirSync(join(parent, "musepi.new-2"), { recursive: true });
		mkdirSync(join(parent, "unrelated"), { recursive: true });
		mkdirSync(join(parent, "musepi.old-not-a-dir"), { recursive: true });

		const removed = cleanupStaleUpdateDirs(installDir);
		expect(removed.map((p) => p.replace(/\\/g, "/")).sort()).toEqual(
			[join(parent, "musepi.new-2"), join(parent, "musepi.old-1"), join(parent, "musepi.old-not-a-dir")]
				.map((p) => p.replace(/\\/g, "/"))
				.sort(),
		);
		expect(existsSync(join(parent, "unrelated"))).toBe(true);
		expect(existsSync(installDir)).toBe(true);
	});
});

describe("windows update script generation", () => {
	const scriptOptions = {
		installDir: "C:\\Users\\test\\apps\\musepi",
		stagedDir: "C:\\Users\\test\\apps\\musepi.new-123",
		backupDir: "C:\\Users\\test\\apps\\musepi.old-123",
		logFile: "C:\\Users\\test\\apps\\musepi.update-123.log",
		parentPid: 4321,
	};

	it("waits for the parent pid, swaps directories with rollback, and verifies --version", () => {
		const script = buildWindowsUpdateScript(scriptOptions);
		// bounded wait for the calling process to exit
		expect(script).toContain("$parentPid = 4321");
		expect(script).toContain("Get-Process -Id $parentPid");
		expect(script).toContain("AddSeconds(120)");
		// swap: install -> backup, staged -> install
		expect(script).toContain("Move-Item -LiteralPath $installDir -Destination $backupDir");
		expect(script).toContain("Move-Item -LiteralPath $stagedDir -Destination $installDir");
		// rollback on failure to move the new version in
		expect(script).toContain("Move-Item -LiteralPath $backupDir -Destination $installDir");
		// post-swap verification + backup retention note
		expect(script).toContain("musepi.exe");
		expect(script).toContain("--version");
		// self cleanup
		expect(script).toContain("$MyInvocation.MyCommand.Path");
		// paths are embedded as single-quoted literals
		expect(script).toContain(`$installDir = 'C:\\Users\\test\\apps\\musepi'`);
		expect(script).toContain(`$stagedDir = 'C:\\Users\\test\\apps\\musepi.new-123'`);
	});

	it("escapes single quotes in paths", () => {
		const script = buildWindowsUpdateScript({
			...scriptOptions,
			installDir: "C:\\Users\\o'brien\\musepi",
		});
		expect(script).toContain(`$installDir = 'C:\\Users\\o''brien\\musepi'`);
	});
});

describe("posix staged update", () => {
	it("replaces the install and keeps the old one as backup", async () => {
		const parent = join(workRoot, "apps");
		const installDir = makeInstallDir(join(parent, "musepi"), { version: "0.1.1" });
		const newRoot = makeInstallDir(join(workRoot, "new", "musepi"), { version: "0.2.0" });
		const stagedDir = stageInstallRoot(newRoot, installDir, "test");

		expect(stagedDir).toBe(stagedDirName(installDir, "test"));
		expect(existsSync(join(stagedDir, "musepi"))).toBe(true);

		const { backupDir } = await applyStagedUpdatePosix({
			installDir,
			stagedDir,
			platform: "linux",
			suffix: "test",
			verify: () => true,
		});

		expect(backupDir).toBe(backupDirName(installDir, "test"));
		// new version is live
		expect(JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")).version).toBe("0.2.0");
		expect(existsSync(join(installDir, "theme", "dark.json"))).toBe(true);
		// old version preserved
		expect(JSON.parse(readFileSync(join(backupDir, "package.json"), "utf8")).version).toBe("0.1.1");
		expect(existsSync(stagedDir)).toBe(false);
	});

	it("rolls back when the new install fails verification", async () => {
		const parent = join(workRoot, "apps");
		const installDir = makeInstallDir(join(parent, "musepi"), { version: "0.1.1" });
		const newRoot = makeInstallDir(join(workRoot, "new", "musepi"), { version: "0.2.0" });
		const stagedDir = stageInstallRoot(newRoot, installDir, "test");

		await expect(
			applyStagedUpdatePosix({ installDir, stagedDir, platform: "linux", suffix: "test", verify: () => false }),
		).rejects.toThrow(/rolled back/);

		// old install restored in place
		expect(JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")).version).toBe("0.1.1");
		// failed attempt kept for diagnosis, backup consumed by the rollback
		expect(existsSync(join(parent, "musepi.failed-test"))).toBe(true);
		expect(existsSync(join(parent, "musepi.old-test"))).toBe(false);
	});
});

describe("end-to-end with a local archive", () => {
	function createReleaseTree(version: string, platform: NodeJS.Platform): string {
		const tree = makeInstallDir(join(workRoot, `release-${version}`, "musepi"), { version, platform });
		mkdirSync(join(tree, "export-html"), { recursive: true });
		writeFileSync(join(tree, "export-html", "template.html"), "<html></html>");
		return tree;
	}

	async function runE2E(archivePath: string, assetName: string, platform: NodeJS.Platform): Promise<void> {
		const parent = join(workRoot, `install-for-${assetName.replace(/\W+/g, "-")}`);
		const installDir = makeInstallDir(join(parent, "musepi"), { version: "0.1.1", platform });

		// mirror the runSelfUpdate pipeline: extract -> validate -> stage -> apply
		const extractDir = join(parent, "extracted");
		extractReleaseArchive(archivePath, extractDir, assetName);
		const installRoot = findInstallRoot(extractDir, platform);
		expect(installRoot).toBeDefined();
		const stagedDir = stageInstallRoot(installRoot!, installDir, "e2e");
		const { backupDir } = await applyStagedUpdatePosix({
			installDir,
			stagedDir,
			platform,
			suffix: "e2e",
			verify: () => true,
		});
		expect(JSON.parse(readFileSync(join(installDir, "package.json"), "utf8")).version).toBe("0.2.0");
		expect(existsSync(join(installDir, "export-html", "template.html"))).toBe(true);
		expect(existsSync(backupDir)).toBe(true);
	}

	it("extracts a tar.gz release (musepi/ wrapper) and swaps it in", async () => {
		const tree = createReleaseTree("0.2.0", "linux");
		const archivePath = join(workRoot, "musepi-linux-x64.tar.gz");
		// wrap in a musepi/ directory, exactly like scripts/build-binaries.sh
		const wrapDir = join(workRoot, "tar-wrap");
		mkdirSync(wrapDir, { recursive: true });
		cpSync(tree, join(wrapDir, "musepi"), { recursive: true });
		// --force-local: GNU tar (Git Bash) would parse "C:\..." as a remote host.
		const tar = spawnSync("tar", ["--force-local", "-czf", archivePath, "-C", wrapDir, "musepi"]);
		expect(tar.status).toBe(0);

		await runE2E(archivePath, "musepi-linux-x64.tar.gz", "linux");
	});

	it.runIf(process.platform === "win32")("extracts a zip release (flat layout) and validates it", async () => {
		const tree = createReleaseTree("0.2.0", "win32");
		const archivePath = join(workRoot, "musepi-windows-x64.zip");
		// powershell.exe is not always on PATH for spawned node children.
		const powershell = join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		const ps = spawnSync(powershell, [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Compress-Archive -LiteralPath '${join(tree, "musepi.exe")}','${join(tree, "package.json")}','${join(tree, "theme")}','${join(tree, "export-html")}' -DestinationPath '${archivePath}' -Force`,
		]);
		expect(ps.status).toBe(0);

		const parent = join(workRoot, "install-for-zip");
		const installDir = makeInstallDir(join(parent, "musepi"), { version: "0.1.1", platform: "win32" });
		const extractDir = join(parent, "extracted");
		extractReleaseArchive(archivePath, extractDir, "musepi-windows-x64.zip");
		const installRoot = findInstallRoot(extractDir, "win32");
		expect(installRoot).toBeDefined();
		const stagedDir = stageInstallRoot(installRoot!, installDir, "e2e");
		// the windows swap runs in the generated script after exit; here we only
		// verify the staged payload is a complete, valid install
		expect(validateInstallRoot(stagedDir, "win32").valid).toBe(true);
		expect(existsSync(join(stagedDir, "export-html", "template.html"))).toBe(true);
	});
});
