import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { encodeBase64Url, formatCollabLink } from "@musepi/collab-proto";

const dom = await import("@happy-dom/global-registrator");
dom.GlobalRegistrator.register();
const hosts = await import("../src/lib/hosts");

afterAll(() => {
	void dom.GlobalRegistrator.unregister();
});

beforeEach(() => localStorage.clear());

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const token = Uint8Array.from({ length: 16 }, (_, index) => index + 32);
const link = formatCollabLink("ws://127.0.0.1:7466", "room-room-1", key, token);

describe("saved hosts", () => {
	it("stores metadata separately from credentials and restores the latest host", async () => {
		const saved = await hosts.rememberHost(link, "Phone", "Study PC");
		expect(saved?.label).toBe("Study PC");
		expect(saved?.deviceName).toBe("Phone");
		expect(saved?.candidates[0]).toMatchObject({ kind: "lan", address: "ws://127.0.0.1:7466/r/room-room-1" });
		expect(localStorage.getItem("musepi.hosts.v1")).not.toContain(encodeBase64Url(key));

		const restored = await hosts.loadResolvedHosts();
		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({ id: saved?.id, label: "Study PC", link });
	});

	it("deduplicates web and direct links for one room and supports rename/delete", async () => {
		const first = await hosts.rememberHost(link, "Phone", "Old");
		const webLink = `http://127.0.0.1:7466/#${link}`;
		const second = await hosts.rememberHost(webLink, "Phone 2");
		expect(second?.id).toBe(first?.id);
		expect(await hosts.loadResolvedHosts()).toHaveLength(1);
		expect((await hosts.loadResolvedHosts())[0]?.label).toBe("Old");

		hosts.renameHost(first!.id, "Desk");
		expect(hosts.loadHosts()[0]?.label).toBe("Desk");
		await hosts.removeHost(first!.id);
		expect(await hosts.loadResolvedHosts()).toEqual([]);
	});

	it("migrates legacy collab recent entries without keeping them as the primary store", async () => {
		localStorage.setItem(
			"musepi.collab.recent",
			JSON.stringify([{ link, name: "Legacy phone", label: "Legacy PC", at: 10 }]),
		);
		const restored = await hosts.loadResolvedHosts();
		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({ label: "Legacy PC", deviceName: "Legacy phone", link });
		expect(localStorage.getItem("musepi.collab.recent")).toBeNull();
		expect(localStorage.getItem("musepi.hosts.v1")).toContain("Legacy PC");
	});
});
