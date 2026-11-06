import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@musepi/pi-utils";
import { codexPluginIcon } from "../compat/codex-plugin-icon";
import type { MarketplacePluginEntry } from "./types";

export interface MarketplaceSkillDetail {
	name: string;
	description: string;
}

export interface MarketplacePluginDetail {
	displayName: string;
	description?: string;
	longDescription?: string;
	icon?: string;
	capabilities: string[];
	skills: MarketplaceSkillDetail[];
}

interface CodexInterface {
	displayName?: unknown;
	longDescription?: unknown;
	capabilities?: unknown;
}

async function readCodexInterface(sourcePath: string): Promise<CodexInterface | undefined> {
	try {
		const plugin = (await Bun.file(path.join(sourcePath, ".codex-plugin", "plugin.json")).json()) as {
			interface?: CodexInterface;
		};
		return plugin.interface;
	} catch {
		return undefined;
	}
}

async function readSkills(sourcePath: string): Promise<MarketplaceSkillDetail[]> {
	const root = path.join(sourcePath, "skills");
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: MarketplaceSkillDetail[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const filePath = path.join(root, entry.name, "SKILL.md");
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch {
			continue;
		}
		const { frontmatter } = parseFrontmatter(content, { source: filePath });
		skills.push({
			name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name : entry.name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readMarketplacePluginDetail(
	sourcePath: string,
	entry: MarketplacePluginEntry,
): Promise<MarketplacePluginDetail> {
	const [icon, codexInterface, skills] = await Promise.all([
		codexPluginIcon(sourcePath),
		readCodexInterface(sourcePath),
		readSkills(sourcePath),
	]);
	return {
		displayName:
			typeof codexInterface?.displayName === "string" && codexInterface.displayName.trim()
				? codexInterface.displayName
				: entry.name,
		description: entry.description,
		longDescription:
			typeof codexInterface?.longDescription === "string" && codexInterface.longDescription.trim()
				? codexInterface.longDescription
				: entry.description,
		icon,
		capabilities: Array.isArray(codexInterface?.capabilities)
			? codexInterface.capabilities.filter((value): value is string => typeof value === "string")
			: [],
		skills,
	};
}
