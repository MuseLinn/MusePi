/**
 * Built-in distribution annotations.
 *
 * This registry no longer declares runnable subsystems. Each first-party
 * subsystem owns a package under `src/bundled-plugins`; discovery creates its
 * only inventory row and Cordis owns its lifecycle. The entries below only mark
 * rows discovered through another capability scanner as shipped with MusePi.
 */
import { BUNDLED_SKILL_NAMES } from "../../bundled-skills/index.ts";
import type { Extension, ExtensionKind } from "./types";

export interface BuiltinExtensionDef {
	kind: ExtensionKind;
	name: string;
	displayName: string;
	description?: string;
	annotate: true;
	raw: unknown;
}

export const BUILTIN_EXTENSIONS: readonly BuiltinExtensionDef[] = [
	...BUNDLED_SKILL_NAMES.map(name => ({
		kind: "skill" as const,
		name,
		displayName: name,
		annotate: true as const,
		raw: { name, kind: "bundled-skill" },
	})),
	{
		kind: "plugin-module",
		name: "capability-center",
		displayName: "MusePi Capability Center",
		description: "Skills, package/bundle management, and marketplace in one Cordis-owned page.",
		annotate: true,
		raw: { name: "capability-center", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "chat-view",
		displayName: "MusePi Chat View",
		description: "Welcome, transcript, and composer in one Cordis-owned surface.",
		annotate: true,
		raw: { name: "chat-view", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "panel",
		displayName: "MusePi Panel",
		description: "Right-panel shell, tabs, split layout, and maximize behavior.",
		annotate: true,
		raw: { name: "panel", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "browser-ui",
		displayName: "MusePi Browser UI",
		description: "Managed browser pane and persistent guest host.",
		annotate: true,
		raw: { name: "browser-ui", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "memory",
		displayName: "MusePi Memory",
		description:
			"Backend selection, workspace memory browser, live status, and maintenance in one Cordis-owned page.",
		annotate: true,
		raw: { name: "memory", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "file-workspace",
		displayName: "MusePi File Workspace",
		description:
			"Workspace tree, Monaco and Markdown editing, PDF and document previews, and file references in one Cordis-owned panel.",
		annotate: true,
		raw: { name: "file-workspace", kind: "plugin-module" },
	},
	{
		kind: "plugin-module",
		name: "scheduled-panel",
		displayName: "MusePi Scheduled Panel",
		description: "Task-center second-tier sidebar panel: search, status filter and workspace groups.",
		annotate: true,
		raw: { name: "scheduled-panel", kind: "plugin-module" },
	},
];

/** Mark discovered rows as first-party without creating duplicate entries. */
export function annotateBuiltinExtensions(extensions: Extension[]): Extension[] {
	const byId = new Map(BUILTIN_EXTENSIONS.map(definition => [`${definition.kind}:${definition.name}`, definition]));
	for (const extension of extensions) {
		const definition = byId.get(extension.id);
		if (definition) {
			extension.builtin = true;
			if (!extension.description && definition.description) extension.description = definition.description;
			continue;
		}
		if (
			(extension.source.provider === "musepi-extensions" || extension.source.provider === "musepi-plugins") &&
			extension.source.level === "native"
		) {
			extension.builtin = true;
		}
	}
	return extensions;
}
