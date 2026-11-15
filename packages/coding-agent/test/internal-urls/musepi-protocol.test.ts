import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@musepi/pi-coding-agent/internal-urls";

describe("MusepiProtocolHandler", () => {
	it("treats musepi://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("musepi://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("musepi://tools/read.md");
		const prefixed = await router.resolve("musepi://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
