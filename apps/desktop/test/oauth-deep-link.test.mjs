import { describe, expect, test } from "bun:test";
import { createOAuthCallbackForwarder, findDeepLink } from "../electron/oauth-deep-link.cjs";

describe("desktop OAuth deep-link forwarding", () => {
	test("finds only the custom-scheme argument", () => {
		expect(findDeepLink(["electron", ".", "musepi://oauth/callback?code=x"])).toBe(
			"musepi://oauth/callback?code=x",
		);
		expect(findDeepLink(["electron", "https://example.com"])).toBeUndefined();
	});

	test("queues one callback until the renderer is ready, then flushes", () => {
		const sent = [];
		let ready = false;
		const forwarder = createOAuthCallbackForwarder({
			send: url => sent.push(url),
			isReady: () => ready,
		});

		expect(forwarder.deliver("musepi://oauth/callback?code=first")).toBe(true);
		expect(forwarder.deliver("musepi://oauth/callback?code=second")).toBe(true);
		expect(sent).toEqual([]);
		expect(forwarder.pending).toBe("musepi://oauth/callback?code=second");

		ready = true;
		expect(forwarder.flush()).toBe(true);
		expect(sent).toEqual(["musepi://oauth/callback?code=second"]);
		expect(forwarder.flush()).toBe(false);

		expect(forwarder.deliver("musepi://oauth/callback?code=third")).toBe(true);
		expect(sent).toEqual(["musepi://oauth/callback?code=second", "musepi://oauth/callback?code=third"]);
	});

	test("ignores non-custom-scheme URLs", () => {
		const forwarder = createOAuthCallbackForwarder({ send: () => {}, isReady: () => true });
		expect(forwarder.deliver("https://example.com/oauth")).toBe(false);
		expect(forwarder.pending).toBeUndefined();
	});
});
