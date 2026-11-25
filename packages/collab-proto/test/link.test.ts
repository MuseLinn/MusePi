/**
 * Contract: a generated join link keeps the room secret in the fragment, so
 * no proxy, CDN edge, or access log between the guest and the relay ever sees
 * it. Legacy links carry the secret dot-joined in the path; they stay
 * parseable (links already handed out keep working) but are no longer
 * generated. The default relay keeps the bare `<roomId>.<key>` form, which is
 * not a URL at all and is only ever expanded into a web fragment.
 */
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_RELAY_URL,
	decodeBase64Url,
	encodeBase64Url,
	formatCollabLink,
	formatCollabWebLink,
	parseCollabLink,
} from "../src/index.ts";

const ROOM = "AbCdEf123456_-Xy";
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const TOKEN = Uint8Array.from({ length: 16 }, (_, i) => 0x41 + i);
const SECRET = new Uint8Array(48);
SECRET.set(KEY, 0);
SECRET.set(TOKEN, 32);
const KEY_TEXT = encodeBase64Url(KEY);
const SECRET_TEXT = encodeBase64Url(SECRET);

function parsed(link: string) {
	const result = parseCollabLink(link);
	if ("error" in result) throw new Error(`${link}: ${result.error}`);
	return result;
}

describe("generated join links", () => {
	it("puts the secret in the fragment on a public relay", () => {
		const link = formatCollabLink("wss://relay.example.com:8443", ROOM, KEY, TOKEN);
		expect(link).toBe(`relay.example.com:8443/r/${ROOM}#${SECRET_TEXT}`);
		// Everything an edge sees is path bytes; the secret is not among them.
		const requestTarget = link.slice(0, link.indexOf("#"));
		expect(requestTarget).not.toContain(SECRET_TEXT);
		expect(requestTarget).not.toContain(KEY_TEXT);
	});

	it("keeps the LAN scheme and still uses the fragment", () => {
		const link = formatCollabLink("ws://192.168.1.5:7466", ROOM, KEY);
		expect(link).toBe(`ws://192.168.1.5:7466/r/${ROOM}#${KEY_TEXT}`);
		expect(parsed(link).wsUrl).toBe(`ws://192.168.1.5:7466/r/${ROOM}`);
	});

	it("refuses to generate a link without a relay, and resolves a bare one only when given its origin", () => {
		// A bare `<roomId>.<key>` names no host. It used to be produced by
		// collapsing onto a built-in default relay, which meant a link quietly
		// pointed at somebody else's server. Now the origin must be supplied.
		expect(() => formatCollabLink("", ROOM, KEY, TOKEN)).toThrow(/Invalid relay URL/);
		const bare = `${ROOM}.${SECRET_TEXT}`;
		const unresolved = parseCollabLink(bare);
		// Still parseable, but it must say what is missing rather than pick a host.
		expect("error" in unresolved && /collab\.relayUrl/.test(unresolved.error)).toBe(true);
		const resolved = parseCollabLink(bare, "wss://relay.example.com");
		if ("error" in resolved) throw new Error(resolved.error);
		expect(resolved.wsUrl).toBe(`wss://relay.example.com/r/${ROOM}`);
		expect(resolved.roomId).toBe(ROOM);
	});

	it("round-trips key and write token through the fragment form", () => {
		const full = parsed(formatCollabLink("wss://relay.example.com", ROOM, KEY, TOKEN));
		expect(full.wsUrl).toBe(`wss://relay.example.com/r/${ROOM}`);
		expect(encodeBase64Url(full.key)).toBe(encodeBase64Url(KEY));
		expect(encodeBase64Url(full.writeToken ?? new Uint8Array())).toBe(encodeBase64Url(TOKEN));

		const view = parsed(formatCollabLink("wss://relay.example.com", ROOM, KEY));
		expect(view.writeToken).toBeUndefined();
	});
});

describe("legacy path-borne secrets", () => {
	it("still parses the old `/r/<roomId>.<key>` form", () => {
		const legacy = `relay.example.com:8443/r/${ROOM}.${SECRET_TEXT}`;
		const result = parsed(legacy);
		expect(result.wsUrl).toBe(`wss://relay.example.com:8443/r/${ROOM}`);
		expect(encodeBase64Url(result.key)).toBe(encodeBase64Url(KEY));
		expect(encodeBase64Url(result.writeToken ?? new Uint8Array())).toBe(encodeBase64Url(TOKEN));
	});

	it("can still be generated on request", () => {
		const legacy = formatCollabLink("wss://relay.example.com", ROOM, KEY, undefined, { keyInPath: true });
		expect(legacy).toBe(`relay.example.com/r/${ROOM}.${KEY_TEXT}`);
		expect(decodeBase64Url(legacy.slice(legacy.lastIndexOf(".") + 1))).toEqual(KEY);
	});
});

describe("web deep links", () => {
	it("keeps the dot form inside the fragment, so no second `#` appears", () => {
		const link = formatCollabWebLink("wss://relay.example.com:8443", ROOM, KEY, TOKEN, "https://web.example");
		expect(link).toBe(`https://web.example/#relay.example.com:8443/r/${ROOM}.${SECRET_TEXT}`);
		expect(link.split("#")).toHaveLength(2);
		const result = parsed(link);
		expect(result.wsUrl).toBe(`wss://relay.example.com:8443/r/${ROOM}`);
	});

	it("parses a wrapped fragment link and its %23-mangled variant", () => {
		const inner = formatCollabLink("wss://relay.example.com:8443", ROOM, KEY, TOKEN);
		for (const wrapper of [`https://web.example/#${inner}`, `https://web.example/#${inner.replace("#", "%23")}`]) {
			const result = parsed(wrapper);
			expect(result.wsUrl).toBe(`wss://relay.example.com:8443/r/${ROOM}`);
			expect(encodeBase64Url(result.key)).toBe(encodeBase64Url(KEY));
		}
	});

	it("resolves the default relay deep link", () => {
		const link = formatCollabWebLink(DEFAULT_RELAY_URL, ROOM, KEY);
		expect(link).toBe(`https://my.omp.sh/#${ROOM}.${KEY_TEXT}`);
		expect(parsed(link).wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${ROOM}`);
	});
});
