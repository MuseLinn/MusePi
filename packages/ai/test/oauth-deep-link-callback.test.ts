import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "../src/registry/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/registry/oauth/types";

class DeepLinkFlow extends OAuthCallbackFlow {
	authorizeUrl = "";
	constructor(redirectUri?: string) {
		super(
			{
				onAuth: info => {
					this.authorizeUrl = info.url;
				},
				signal: new AbortController().signal,
			} satisfies OAuthController,
			{
				preferredPort: 0,
				redirectUri,
				externalCallbackOnly: true,
			},
		);
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		return { url: `https://as.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}` };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { refresh: "refresh", access: `access:${code}`, expires: Date.now() + 60_000 };
	}
}

function stateOf(url: string): string {
	return new URL(url).searchParams.get("state") ?? "";
}

describe("OAuth deep-link callback", () => {
	it("requires a redirect URI when no loopback server is used", () => {
		expect(() => new DeepLinkFlow()).toThrow("externalCallbackOnly requires oauth.redirectUri");
	});

	it("resolves the flow from a submitted custom-scheme callback", async () => {
		const flow = new DeepLinkFlow("musepi://oauth/callback");
		const pending = flow.login();
		// `onAuth` is synchronous inside login; give the microtask queue a turn.
		await Bun.sleep(0);
		const state = stateOf(flow.authorizeUrl);
		expect(state.length).toBeGreaterThan(0);

		expect(flow.submitCallbackUrl(`musepi://oauth/callback?code=abc&state=${state}`)).toBe(true);
		await expect(pending).resolves.toMatchObject({ access: "access:abc" });
	});

	it("ignores a callback with a mismatched state and accepts the next one", async () => {
		const flow = new DeepLinkFlow("musepi://oauth/callback");
		const pending = flow.login();
		await Bun.sleep(0);
		const state = stateOf(flow.authorizeUrl);

		expect(flow.submitCallbackUrl("musepi://oauth/callback?code=bad&state=wrong")).toBe(false);
		expect(flow.submitCallbackUrl(`musepi://oauth/callback?code=good&state=${state}`)).toBe(true);
		await expect(pending).resolves.toMatchObject({ access: "access:good" });
	});

	it("queues a callback that arrives before the flow starts waiting", async () => {
		const flow = new DeepLinkFlow("musepi://oauth/callback");
		const queued = flow.submitCallbackUrl("musepi://oauth/callback?code=early&state=early-state");
		expect(queued).toBe(true);

		const pending = flow.login();
		await Bun.sleep(0);
		// The queued callback's state does not match the generated state; the
		// flow must keep waiting rather than resolve with the early code.
		const state = stateOf(flow.authorizeUrl);
		expect(flow.submitCallbackUrl(`musepi://oauth/callback?code=late&state=${state}`)).toBe(true);
		await expect(pending).resolves.toMatchObject({ access: "access:late" });
	});
});
