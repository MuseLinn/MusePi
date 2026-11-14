import { describe, expect, it } from "bun:test";
import {
	type ApplicationEntry,
	type ApplicationProvider,
	ApplicationProviderRegistry,
} from "../../src/tools/computer/app-provider";

const entry: ApplicationEntry = { id: "/a/Notion.lnk", name: "Notion", path: "/a/Notion.lnk", kind: "native" };

function provider(name: string): ApplicationProvider {
	return {
		name,
		async list() {
			return [entry];
		},
		async open() {
			return { path: entry.path };
		},
	};
}

describe("application provider registry", () => {
	it("holds exactly one named provider and reports it", () => {
		const registry = new ApplicationProviderRegistry();
		expect(registry.providerName).toBeNull();
		const release = registry.register(provider("native"));
		expect(registry.providerName).toBe("native");
		expect(registry.provider?.name).toBe("native");

		release();
		expect(registry.providerName).toBeNull();
		expect(registry.provider).toBeNull();
	});

	it("refuses a second registration and names the incumbent", () => {
		const registry = new ApplicationProviderRegistry();
		registry.register(provider("native"));
		expect(() => registry.register(provider("remote"))).toThrow(/"native" is already registered/);
	});

	it("keeps a newer registration alive when an older disposer runs late", () => {
		const registry = new ApplicationProviderRegistry();
		const releaseFirst = registry.register(provider("native"));
		releaseFirst();
		const releaseSecond = registry.register(provider("remote"));
		releaseFirst();
		expect(registry.providerName).toBe("remote");
		releaseSecond();
		expect(registry.providerName).toBeNull();
	});

	it("stops routing to a provider once its disposer runs", () => {
		const registry = new ApplicationProviderRegistry();
		const release = registry.register(provider("native"));
		release();
		release();
		expect(registry.provider).toBeNull();
	});
});
