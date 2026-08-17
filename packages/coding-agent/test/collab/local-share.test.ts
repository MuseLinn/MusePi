/**
 * Contract: LocalShareManager coordinates the relay server + tunnel lifecycle
 * for /collab lan|tunnel. Pure helpers and idempotent teardown are tested
 * here; live LAN/tunnel sharing is covered by the interactive smoke.
 */
import { describe, expect, it } from "bun:test";
import {
	findLanIpv4,
	isRfc1918,
	isTailscaleIpv4,
	LocalShareManager,
	listLanIpv4,
} from "@musepi/pi-coding-agent/collab/local-share";

describe("isTailscaleIpv4", () => {
	it("recognizes the 100.64/10 CGNAT range", () => {
		expect(isTailscaleIpv4("100.64.0.1")).toBe(true);
		expect(isTailscaleIpv4("100.127.255.255")).toBe(true);
		expect(isTailscaleIpv4("100.63.255.255")).toBe(false);
		expect(isTailscaleIpv4("100.128.0.1")).toBe(false);
		expect(isTailscaleIpv4("192.168.1.5")).toBe(false);
		expect(isTailscaleIpv4("10.0.0.1")).toBe(false);
	});
});

describe("isRfc1918", () => {
	it("recognizes private ranges and rejects public/odd addresses", () => {
		expect(isRfc1918("10.0.0.1")).toBe(true);
		expect(isRfc1918("10.255.255.255")).toBe(true);
		expect(isRfc1918("172.16.0.1")).toBe(true);
		expect(isRfc1918("172.31.255.254")).toBe(true);
		expect(isRfc1918("192.168.1.5")).toBe(true);
		expect(isRfc1918("172.15.0.1")).toBe(false); // just below 172.16/12
		expect(isRfc1918("172.32.0.1")).toBe(false); // just above 172.31/12
		expect(isRfc1918("8.8.8.8")).toBe(false);
		expect(isRfc1918("169.254.10.10")).toBe(false); // link-local, not RFC 1918
		expect(isRfc1918("100.64.0.1")).toBe(false); // CGNAT
	});
});

describe("findLanIpv4", () => {
	it("returns a non-internal, non-link-local IPv4 or null without throwing", () => {
		const ip = findLanIpv4();
		if (ip !== null) {
			expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
			expect(ip).not.toBe("127.0.0.1");
			expect(ip).not.toMatch(/^169\.254\./);
		}
	});

	it("listLanIpv4 ranks RFC 1918 addresses first (BitFun-style NIC discovery)", () => {
		const list = listLanIpv4();
		const first = list[0]?.address;
		if (first !== undefined) {
			// If the machine has any private address, it must be the top pick.
			if (list.some(e => isRfc1918(e.address))) expect(isRfc1918(first)).toBe(true);
			for (const e of list) {
				expect(e.address).not.toMatch(/^(127\.|169\.254\.)/);
			}
		}
	});
});

describe("LocalShareManager", () => {
	it("stop() is idempotent and safe on a fresh instance", async () => {
		const manager = new LocalShareManager({ port: 0 });
		await manager.stop();
		await manager.stop();
		expect(manager.relay).toBeNull();
		expect(manager.tunnel).toBeNull();
	});

	it("reports whether the desktop-web dist is available for static serving", () => {
		const manager = new LocalShareManager();
		expect(typeof manager.webDistAvailable).toBe("boolean");
	});

	it("startLan() returns plaintext ws join + https/wss web URLs", async () => {
		const ip = findLanIpv4();
		if (!ip) return; // headless hosts without a routable NIC skip this
		const manager = new LocalShareManager({ port: 0 });
		const urls = await manager.startLan();
		expect(urls.joinUrl).toBe(`ws://${ip}:${manager.relay?.port}`);
		expect(urls.webUrl).toBe(`https://${ip}:${manager.tlsRelay?.port}`);
		expect(urls.webJoinUrl).toBe(`wss://${ip}:${manager.tlsRelay?.port}`);
		// Every listed extra NIC gets its own reachable URL set (Tailscale etc.).
		expect(Array.isArray(urls.alt)).toBe(true);
		for (const a of urls.alt ?? []) {
			expect(a.joinUrl).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
			expect(a.webUrl).toMatch(/^https:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
			expect(a.webJoinUrl).toMatch(/^wss:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
		}
		await manager.stop();
		expect(manager.relay).toBeNull();
		expect(manager.tlsRelay).toBeNull();
	});
});
