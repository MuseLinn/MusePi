import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pathIsWithin } from "@musepi/pi-utils";

async function codexPluginIcon(cachePath: string): Promise<string | undefined> {
	try {
		const plugin = (await Bun.file(path.join(cachePath, ".codex-plugin", "plugin.json")).json()) as {
			interface?: { logo?: unknown };
		};
		const logo = plugin.interface?.logo;
		if (typeof logo !== "string" || !logo.trim()) return undefined;
		const iconPath = path.resolve(cachePath, logo);
		if (!pathIsWithin(cachePath, iconPath) || !(await Bun.file(iconPath).exists())) return undefined;
		return pathToFileURL(iconPath).href;
	} catch {
		return undefined;
	}
}

export async function adaptThirdPartyCordisPlugin(cachePath: string): Promise<void> {
	const manifestPath = path.join(cachePath, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>;
	const icon = await codexPluginIcon(cachePath);
	if (manifest.name === "superpowers") {
		manifest.musepi = {
			description: "Planning, TDD, debugging, and delivery workflows for coding agents",
			extensions: ["./.pi/extensions/superpowers.ts"],
			...(icon ? { icon } : {}),
		};
	} else if (manifest.name === "modern-web-guidance") {
		manifest.musepi = {
			description: "Modern Web development best practices",
			extensions: ["./cordis/index.ts"],
			...(icon ? { icon } : {}),
		};
		await fs.mkdir(path.join(cachePath, "cordis"), { recursive: true });
		await fs.copyFile(
			path.resolve(import.meta.dir, "modern-web-guidance-adapter.ts"),
			path.join(cachePath, "cordis", "index.ts"),
		);
	} else {
		return;
	}
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
