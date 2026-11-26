import "./happy-dom-shim";
import { afterAll, describe, expect, it } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { navGroups } from "../src/components/SettingsNav";
import * as indexLibrary from "../src/plugins/index-library/index";
import { apply } from "../src/plugins/index-library/index";

const previousLocale = getLocaleSnapshot();
setLocale("zh-CN");

afterAll(() => setLocale(previousLocale));

describe("index-library Cordis plugin", () => {
	it("registers the settings.section entry with id indexes and takes over that page", () => {
		const registrations: unknown[] = [];
		apply({
			slots: {
				register(component) {
					registrations.push(component);
				},
			},
		});
		expect(registrations).toHaveLength(1);
		const [registration] = registrations as [{ slot: string; id: string; moduleUrl: string }];
		expect(registration.slot).toBe("settings.section");
		expect(registration.id).toBe("indexes");
		expect(registration.moduleUrl).toBe("./page.tsx");
	});

	it("owns the real page implementation instead of wrapping a host component", async () => {
		// The package used to render the host's `IndexesSection`; the body now
		// lives in this package, so the module is self-contained.
		const source = await Bun.file(new URL("../src/plugins/index-library/page.tsx", import.meta.url)).text();
		expect(source).not.toContain("components/settings-sections/indexes");
		expect(source).toContain("export default function IndexLibraryPage");
	});

	it("keeps its nav row only while the contribution is loaded", () => {
		const unclaimed = navGroups([]).flatMap(group => group.items);
		expect(unclaimed.some(item => item.id === "indexes")).toBe(false);

		const items = navGroups([{ id: "indexes", label: "索引库" }]).flatMap(group => group.items);
		expect(items.some(item => item.id === "indexes")).toBe(true);
		expect(items.some(item => item.id === "ext:indexes")).toBe(false);
	});

	it("still exports the package identity the loader matches on", () => {
		expect(indexLibrary.name).toBe("musepi-index-library");
	});
});
