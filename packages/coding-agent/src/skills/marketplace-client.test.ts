import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { topSkillHub } from "./marketplace-client";

/**
 * An entry's id is `source:slug` and doubles as the renderer's React key. The
 * catalog lists a slug more than once — once per published version, or once per
 * namespace alias — and two rows under one key make React drop the whole
 * subtree rather than one card: the marketplace went blank behind the error
 * boundary, and the person was offered a retry button that could not help
 * because the duplicate came back with the next fetch.
 *
 * These cases feed the client a catalog that repeats itself and check what
 * reaches the list.
 */
function catalogResponse(skills: unknown[], total?: number): Response {
	const body = JSON.stringify({ data: { skills, total: total ?? skills.length } });
	return new Response(body, { headers: { "content-type": "application/json" } });
}

describe("skill catalog duplicate slugs", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	it("collapses a slug the catalog lists twice into one row", async () => {
		// The failure itself: two rows, one id, blank screen.
		spyOn(globalThis, "fetch").mockResolvedValue(
			catalogResponse([
				{ slug: "dev-expert", name: "Dev Expert", downloads: 10 },
				{ slug: "dev-expert", name: "Dev Expert", downloads: 10 },
			]),
		);

		const entries = await topSkillHub(12);

		expect(entries.map(e => e.id)).toEqual(["skillhub:dev-expert"]);
	});

	it("keeps distinct slugs that happen to share a name", async () => {
		// Deduplication is by id, not by display name: two skills can legitimately
		// be called the same thing, and collapsing them would hide one.
		spyOn(globalThis, "fetch").mockResolvedValue(
			catalogResponse([
				{ slug: "team-a/dev-expert", name: "Dev Expert" },
				{ slug: "team-b/dev-expert", name: "Dev Expert" },
			]),
		);

		const entries = await topSkillHub(12);

		expect(entries.map(e => e.slug)).toEqual(["team-a/dev-expert", "team-b/dev-expert"]);
	});

	it("still fills the requested page when the head of the catalog repeats", async () => {
		// Slicing before deduplication would shrink the page: ask for eight and get
		// six because the first two rows were the same skill. A page that returns
		// fewer cards than asked for reads as an empty result.
		const rows: unknown[] = [];
		for (let i = 0; i < 3; i++) rows.push({ slug: "top-skill", downloads: 100 });
		for (let i = 0; i < 10; i++) rows.push({ slug: `skill-${i}`, downloads: 50 - i });
		spyOn(globalThis, "fetch").mockResolvedValue(catalogResponse(rows));

		const entries = await topSkillHub(8);

		expect(entries).toHaveLength(8);
		expect(new Set(entries.map(e => e.id)).size).toBe(8);
		expect(entries[0]?.id).toBe("skillhub:top-skill");
	});
});
