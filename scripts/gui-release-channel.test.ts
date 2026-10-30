import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertChannelPromotion,
	fetchCurrentChannelVersion,
	mergeWindowsFeeds,
	verifyPublishedManifest,
} from "./gui-release-channel.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-gui-channel-"));
	temporaryDirectories.push(dir);
	return dir;
}

function installerName(version: string, arch: string): string {
	return arch === "arm64" ? `MusePi-${version}-arm64-setup.exe` : `MusePi-${version}-setup.exe`;
}

function feed(version: string, arch: string): string {
	return [
		`version: ${version}`,
		"files:",
		`  - url: ${installerName(version, arch)}`,
		"    sha512: test-sha",
		"    size: 123",
		`path: ${installerName(version, "x64")}`,
		"sha512: test-sha",
		"releaseDate: '2026-10-29T00:00:00.000Z'",
		"",
	].join("\n");
}

async function writeInstallers(dist: string, version: string, arches: string[]): Promise<void> {
	for (const arch of arches) await Bun.write(path.join(dist, installerName(version, arch)), `${arch}-final-bytes`);
}

describe("GUI release channels", () => {
	it("merges both Windows architectures into beta.yml without emitting latest.yml", async () => {
		const dist = await makeTempDir();
		await Bun.write(path.join(dist, "beta-win-x64.yml"), feed("0.6.4-beta.2", "x64"));
		await Bun.write(path.join(dist, "beta-win-arm64.yml"), feed("0.6.4-beta.2", "arm64"));
		await writeInstallers(dist, "0.6.4-beta.2", ["x64", "arm64"]);

		const output = await mergeWindowsFeeds(dist, "beta");

		expect(path.basename(output)).toBe("beta.yml");
		const merged = Bun.YAML.parse(await Bun.file(output).text()) as {
			version: string;
			files: Array<{ url: string }>;
		};
		expect(merged.version).toBe("0.6.4-beta.2");
		expect(merged.files.map(file => file.url)).toEqual([
			"MusePi-0.6.4-beta.2-setup.exe",
			"MusePi-0.6.4-beta.2-arm64-setup.exe",
		]);
		expect(await Bun.file(path.join(dist, "latest.yml")).exists()).toBe(false);
	});

	it("keeps the stable Windows feed on latest.yml", async () => {
		const dist = await makeTempDir();
		await Bun.write(path.join(dist, "latest-win-x64.yml"), feed("0.6.3", "x64"));
		await writeInstallers(dist, "0.6.3", ["x64"]);

		const output = await mergeWindowsFeeds(dist, "latest");

		expect(path.basename(output)).toBe("latest.yml");
		expect(Bun.YAML.parse(await Bun.file(output).text())).toMatchObject({ version: "0.6.3" });
	});

	it("hashes the final wrapped installers instead of trusting stale builder feeds", async () => {
		const dist = await makeTempDir();
		const version = "0.6.3";
		await Bun.write(path.join(dist, "latest-win-x64.yml"), feed(version, "x64"));
		await Bun.write(path.join(dist, "latest-win-arm64.yml"), feed(version, "arm64"));
		const x64Bytes = new TextEncoder().encode("wrapped-x64-installer");
		const arm64Bytes = new TextEncoder().encode("wrapped-arm64-installer");
		await Bun.write(path.join(dist, installerName(version, "x64")), x64Bytes);
		await Bun.write(path.join(dist, installerName(version, "arm64")), arm64Bytes);

		const output = await mergeWindowsFeeds(dist, "latest");
		const merged = Bun.YAML.parse(await Bun.file(output).text()) as {
			files: Array<{ url: string; sha512: string; size: number }>;
			path: string;
			sha512: string;
		};
		const x64Hash = createHash("sha512").update(x64Bytes).digest("base64");
		const arm64Hash = createHash("sha512").update(arm64Bytes).digest("base64");

		expect(merged.files).toEqual([
			{ url: installerName(version, "x64"), sha512: x64Hash, size: x64Bytes.length },
			{ url: installerName(version, "arm64"), sha512: arm64Hash, size: arm64Bytes.length },
		]);
		expect(merged.path).toBe(installerName(version, "x64"));
		expect(merged.sha512).toBe(x64Hash);
	});

	it("refuses to publish a feed whose installer is missing", async () => {
		const dist = await makeTempDir();
		await Bun.write(path.join(dist, "latest-win-x64.yml"), feed("0.6.3", "x64"));

		await expect(mergeWindowsFeeds(dist, "latest")).rejects.toThrow();
	});

	it("rejects an older or repeated beta before it can replace the channel", () => {
		expect(() => assertChannelPromotion("0.6.4-beta.2", "0.6.4-beta.1")).not.toThrow();
		expect(() => assertChannelPromotion("0.6.4-beta.1", "0.6.4-beta.2")).toThrow("refusing to replace");
		expect(() => assertChannelPromotion("0.6.4-beta.2", "0.6.4-beta.2")).toThrow("refusing to replace");
		expect(() => assertChannelPromotion("0.6.4", "0.6.3")).not.toThrow();
	});

	it("allows an initial beta only on 404 and fails closed on other read errors", async () => {
		const response = async (status: number): Promise<Response> =>
			status === 200 ? Response.json({ version: "0.6.4-beta.2" }) : new Response(null, { status });

		await expect(fetchCurrentChannelVersion(() => response(404))).resolves.toBeUndefined();
		await expect(fetchCurrentChannelVersion(() => response(200))).resolves.toBe("0.6.4-beta.2");
		await expect(fetchCurrentChannelVersion(() => response(500))).rejects.toThrow("returned 500");
		await expect(fetchCurrentChannelVersion(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
	});

	it("reads back the exact published version from the selected channel", async () => {
		const urls: string[] = [];
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			urls.push(String(input));
			return Response.json({ version: "0.6.4-beta.2" });
		};

		await verifyPublishedManifest("0.6.4-beta.2", fetchImpl);

		expect(urls).toEqual(["https://github.com/MuseLinn/MusePi/releases/download/channel-beta/update-manifest.json"]);
		await expect(verifyPublishedManifest("0.6.4-beta.3", fetchImpl)).rejects.toThrow("expected 0.6.4-beta.3");
	});
});
