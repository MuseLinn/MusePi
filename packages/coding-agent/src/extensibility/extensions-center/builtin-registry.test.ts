import { describe, expect, it } from "bun:test";
import { BUNDLED_SKILL_NAMES } from "../../bundled-skills/index.ts";
import { annotateBuiltinExtensions, BUILTIN_EXTENSIONS } from "./builtin-registry";
import { buildProviderTabs, buildSidebarTree, filterByProvider } from "./state-manager";
import type { Extension } from "./types";

describe("builtin distribution annotations", () => {
	it("covers every bundled skill without declaring subsystem rows", () => {
		const skills = BUILTIN_EXTENSIONS.filter(definition => definition.kind === "skill");
		expect(skills.map(definition => definition.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort());
		expect(BUILTIN_EXTENSIONS.every(definition => definition.annotate)).toBe(true);
		expect(BUILTIN_EXTENSIONS.some(definition => definition.kind === "voice" || definition.kind === "terminal")).toBe(
			false,
		);
	});

	it("marks matching scanned skills and leaves user skills unchanged", () => {
		const scanned: Extension[] = [
			{
				id: "skill:musepi-help",
				kind: "skill",
				name: "musepi-help",
				displayName: "musepi-help",
				path: "/home/u/.musepi/agent/skills/musepi-help/SKILL.md",
				source: { provider: "native", providerName: "MusePi", level: "user" },
				state: "active",
				raw: {},
			},
			{
				id: "skill:my-own",
				kind: "skill",
				name: "my-own",
				displayName: "my-own",
				path: "/p/skills/my-own/SKILL.md",
				source: { provider: "native", providerName: "MusePi", level: "project" },
				state: "active",
				raw: {},
			},
		];
		const annotated = annotateBuiltinExtensions(scanned);
		expect(annotated[0]?.builtin).toBe(true);
		expect(annotated[1]?.builtin).toBeUndefined();
	});

	it("uses native discovery scope for desktop bundled plugins outside bundled-plugins directories", () => {
		const scanned: Extension[] = [
			{
				id: "musepi-capability-center",
				kind: "plugin-module",
				name: "musepi-capability-center",
				displayName: "musepi-capability-center",
				path: "D:/product/desktop-app/src/plugins/capability-center/index.ts",
				source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
				state: "active",
				raw: {},
			},
		];
		expect(annotateBuiltinExtensions(scanned)[0]?.builtin).toBe(true);
	});
});

describe("provider tab visibility", () => {
	const fixture: Extension[] = [
		{
			id: "skill:musepi-help",
			kind: "skill",
			name: "musepi-help",
			displayName: "musepi-help",
			path: "",
			source: { provider: "native", providerName: "MusePi", level: "user" },
			state: "active",
			builtin: true,
			raw: {},
		},
		{
			id: "stt",
			kind: "plugin-module",
			name: "stt",
			displayName: "语音输入（STT）",
			path: "",
			source: { provider: "musepi-extensions", providerName: "MusePi Plugins", level: "native" },
			state: "active",
			builtin: true,
			raw: {},
		},
	];

	it("counts native entries and keeps the native sidebar node", () => {
		expect(buildProviderTabs(fixture).find(tab => tab.id === "native")?.count).toBe(1);
		expect(buildSidebarTree(fixture).some(node => node.id === "native")).toBe(true);
	});

	it("filters native entries independently from first-party plugin packages", () => {
		expect(filterByProvider(fixture, "native").map(extension => extension.id)).toEqual(["skill:musepi-help"]);
		expect(filterByProvider(fixture, "musepi-extensions").map(extension => extension.id)).toEqual(["stt"]);
	});
});
