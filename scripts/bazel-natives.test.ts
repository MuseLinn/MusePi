import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	conventionOutputPaths,
	type HostInfo,
	hostTargetName,
	parseBazelFilesOutput,
	parseCliArgs,
	resolveTargetLabels,
} from "./bazel-natives";

const linuxModern: HostInfo = { platform: "linux", arch: "x64", avx2: true };
const linuxBaseline: HostInfo = { platform: "linux", arch: "x64", avx2: false };
const macArm: HostInfo = { platform: "darwin", arch: "arm64", avx2: false };

describe("hostTargetName", () => {
	test("picks the x64 variant from AVX2 support", () => {
		expect(hostTargetName(linuxModern)).toBe("linux-x64-modern");
		expect(hostTargetName(linuxBaseline)).toBe("linux-x64-baseline");
		// darwin x64 ships baseline only; AVX2 must not invent a modern target.
		expect(hostTargetName({ platform: "darwin", arch: "x64", avx2: true })).toBe("darwin-x64-baseline");
	});

	test("maps non-x64 and windows hosts", () => {
		expect(hostTargetName(macArm)).toBe("darwin-arm64");
		expect(hostTargetName({ platform: "linux", arch: "arm64", avx2: false })).toBe("linux-arm64");
		expect(hostTargetName({ platform: "win32", arch: "x64", avx2: true })).toBe("win32-x64-baseline");
	});

	test("rejects hosts without an addon target", () => {
		expect(() => hostTargetName({ platform: "freebsd", arch: "x64", avx2: false })).toThrow(
			/No pi_natives addon target/,
		);
		expect(() => hostTargetName({ platform: "win32", arch: "arm64", avx2: false })).toThrow(
			/No pi_natives addon target/,
		);
	});
});

describe("resolveTargetLabels", () => {
	test("maps explicit names, pseudo-targets, and aggregates to labels", () => {
		expect(resolveTargetLabels(["linux-x64-baseline", "linux-x64-modern"], macArm)).toEqual([
			"//:natives-linux-x64-baseline",
			"//:natives-linux-x64-modern",
		]);
		expect(resolveTargetLabels(["host"], linuxModern)).toEqual(["//:natives-linux-x64-modern"]);
		expect(resolveTargetLabels(["linux-all", "darwin-all"], macArm)).toEqual([
			"//:natives-linux-all",
			"//:natives-darwin-all",
		]);
	});

	test("deduplicates and rejects unknown targets", () => {
		expect(resolveTargetLabels(["host", "darwin-arm64"], macArm)).toEqual(["//:natives-darwin-arm64"]);
		expect(() => resolveTargetLabels(["linux-x64"], macArm)).toThrow(/Unknown native target "linux-x64"/);
	});
});

describe("conventionOutputPaths", () => {
	test("builds bazel-bin paths with canonical filenames (musl reuses linux names)", () => {
		expect(conventionOutputPaths(["linux-musl-x64-baseline", "win32-x64-baseline"], macArm)).toEqual([
			"bazel-bin/natives-linux-musl-x64-baseline/pi_natives.linux-x64-baseline.node",
			"bazel-bin/natives-win32-x64-baseline/pi_natives.win32-x64-baseline.node",
		]);
	});

	test("expands aggregates and the host pseudo-target", () => {
		expect(conventionOutputPaths(["darwin-all"], macArm)).toEqual([
			"bazel-bin/natives-darwin-arm64/pi_natives.darwin-arm64.node",
			"bazel-bin/natives-darwin-x64-baseline/pi_natives.darwin-x64-baseline.node",
		]);
		expect(conventionOutputPaths(["host"], linuxBaseline)).toEqual([
			"bazel-bin/natives-linux-x64-baseline/pi_natives.linux-x64-baseline.node",
		]);
	});
});

describe("parseBazelFilesOutput", () => {
	test("keeps only .node paths, trimmed and deduplicated", () => {
		const output = [
			"bazel-bin/natives-linux-x64-baseline/pi_natives.linux-x64-baseline.node",
			"  bazel-bin/natives-linux-x64-modern/pi_natives.linux-x64-modern.node  ",
			"bazel-bin/natives-linux-x64-baseline/pi_natives.linux-x64-baseline.node",
			"INFO: Analyzed 2 targets (0 packages loaded, 0 targets configured).",
			"",
		].join("\n");
		expect(parseBazelFilesOutput(output)).toEqual([
			"bazel-bin/natives-linux-x64-baseline/pi_natives.linux-x64-baseline.node",
			"bazel-bin/natives-linux-x64-modern/pi_natives.linux-x64-modern.node",
		]);
	});

	test("returns empty for output without addon files", () => {
		expect(parseBazelFilesOutput("INFO: Build completed successfully\n")).toEqual([]);
	});
});

describe("parseCliArgs", () => {
	test("splits targets, paths, and passthrough bazel args", () => {
		expect(
			parseCliArgs(["linux-x64-baseline", "linux-x64-modern", "--dest", "out", "--", "--config=ci", "--dest"]),
		).toEqual({
			targets: ["linux-x64-baseline", "linux-x64-modern"],
			dest: "out",
			source: null,
			bazelArgs: ["--config=ci", "--dest"],
		});
		expect(parseCliArgs(["host", "--source", "artifact"])).toEqual({
			targets: ["host"],
			dest: null,
			source: "artifact",
			bazelArgs: [],
		});
	});

	test("rejects invalid build and artifact source combinations", () => {
		expect(() => parseCliArgs([])).toThrow(/Usage:/);
		expect(() => parseCliArgs(["--", "--config=ci"])).toThrow(/Usage:/);
		expect(() => parseCliArgs(["host", "--config=ci"])).toThrow(/Unknown flag --config=ci/);
		expect(() => parseCliArgs(["host", "--dest"])).toThrow(/--dest requires/);
		expect(() => parseCliArgs(["host", "--source"])).toThrow(/--source requires/);
		expect(() => parseCliArgs(["host", "--source", "artifact", "--", "--config=ci"])).toThrow(
			/--source cannot be combined/,
		);
	});
});

describe("artifact source install", () => {
	test("installs exact target outputs without invoking Bazel", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-artifacts-"));
		const source = path.join(root, "source");
		const dest = path.join(root, "dest");
		const baseline = "pi_natives.linux-x64-baseline.node";
		const modern = "pi_natives.linux-x64-modern.node";
		try {
			await fs.mkdir(path.join(source, "natives-linux-x64-baseline"), { recursive: true });
			await fs.mkdir(path.join(source, "natives-linux-x64-modern"), { recursive: true });
			await Bun.write(path.join(source, "natives-linux-x64-baseline", baseline), "baseline");
			await Bun.write(path.join(source, "natives-linux-x64-modern", modern), "modern");

			const result =
				await $`${process.execPath} ${path.join(import.meta.dir, "bazel-natives.ts")} linux-x64-baseline linux-x64-modern --source ${source} --dest ${dest}`
					.quiet()
					.nothrow();

			expect(result.exitCode).toBe(0);
			expect(await Bun.file(path.join(dest, baseline)).text()).toBe("baseline");
			expect(await Bun.file(path.join(dest, modern)).text()).toBe("modern");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
