import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pathIsWithin } from "@musepi/pi-utils";

export async function codexPluginIcon(cachePath: string): Promise<string | undefined> {
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
