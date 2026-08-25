import { describe, expect, test } from "bun:test";
import { FX_RATES_TTL_MS, getFxRates } from "../../src/daemon/fx-rates";

/** Fake JSON Response for fetch mocks. */
function jsonResponse(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

type MockFetch = typeof fetch;

/** A fetch stub whose impl receives (url, init) and returns Response/throws. */
function mockFetch(impl: () => Response | Promise<Response>): MockFetch {
	return (async () => {
		return impl();
	}) as unknown as MockFetch;
}

describe("getFxRates (widget.data FX feed cache/parse)", () => {
	test("parses a success payload into numeric rates (filters non-numeric)", async () => {
		const fetch = mockFetch(() =>
			jsonResponse({ result: "success", rates: { EUR: 0.128, USD: 0.138, JPY: 20.5, BAD: "x" } }),
		);
		const rates = await getFxRates("EUR", { fetch });
		expect(rates).toEqual({ EUR: 0.128, USD: 0.138, JPY: 20.5 });
	});

	test("returns null on a non-success result or missing rates", async () => {
		const err = mockFetch(() => jsonResponse({ result: "error", rates: {} }));
		expect(await getFxRates("USD", { fetch: err })).toBeNull();
		const noRates = mockFetch(() => jsonResponse({ result: "success" }));
		expect(await getFxRates("USD2", { fetch: noRates })).toBeNull();
	});

	test("returns null on network failure and does not cache the failure", async () => {
		let calls = 0;
		const fetch = mockFetch(() => {
			calls++;
			throw new Error("network");
		});
		expect(await getFxRates("GBP", { fetch })).toBeNull();
		// A retry re-fetches — failures are never cached.
		expect(await getFxRates("GBP", { fetch })).toBeNull();
		expect(calls).toBe(2);
	});

	test("caches within TTL and refetches after expiry", async () => {
		let t = 0;
		let calls = 0;
		const fetch = mockFetch(() => {
			calls++;
			return jsonResponse({ result: "success", rates: { EUR: 0.128 } });
		});
		const now = (): number => t;
		await getFxRates("CNY", { fetch, now });
		expect(calls).toBe(1);
		// Same clock → cache hit, no second fetch.
		await getFxRates("CNY", { fetch, now });
		expect(calls).toBe(1);
		// Past TTL → refetch.
		t = FX_RATES_TTL_MS + 1;
		await getFxRates("CNY", { fetch, now });
		expect(calls).toBe(2);
	});

	test("coalesces concurrent requests for the same base into one fetch", async () => {
		let calls = 0;
		let release!: (r: Response) => void;
		const gate = new Promise<Response>(r => {
			release = r;
		});
		const fetch = mockFetch(() => {
			calls++;
			return gate;
		});
		const p1 = getFxRates("JPY", { fetch });
		const p2 = getFxRates("JPY", { fetch });
		// Only one network request for the in-flight window.
		expect(calls).toBe(1);
		release(jsonResponse({ result: "success", rates: { EUR: 0.128 } }));
		expect(await p1).toEqual({ EUR: 0.128 });
		expect(await p2).toEqual({ EUR: 0.128 });
		expect(calls).toBe(1);
	});
});
