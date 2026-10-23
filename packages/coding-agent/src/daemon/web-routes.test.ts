/**
 * 插件自有 HTTP 路由 —— 派发顺序与信任围栏。
 *
 * 守两条对外契约：
 * 1. **精确优先于前缀、前缀最长优先**：事件流（exact `/api/x/events`）与数据面
 *    （prefix `/api/x/*`）共存时，前者不能被后者吃掉；
 * 2. **跨源一律拒绝**：服务绑在 loopback，但本机任意网页都能发请求，插件的数据
 *    面不能对它们开放。
 */

import { describe, expect, test } from "bun:test";
import { RouteTable, rejectionForOrigin } from "./web-routes";

/** A handler that echoes its own name, so the winner is visible. */
function named(name: string) {
	return () => new Response(name);
}

/** One request against the table's origin. */
function request(table: RouteTable, path: string, headers: Record<string, string> = {}): Request {
	return new Request(`${table.origin}${path}`, { headers });
}

describe("RouteTable dispatch", () => {
	test("an exact route outranks a prefix that also matches", async () => {
		// The recorded shape: the JSON API claims `/api/x/*` and the event stream
		// claims `/api/x/events` exactly. Registration order must not decide —
		// otherwise a prefix registered first swallows the socket.
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/x", handler: named("api") });
		table.register({ kind: "exact", path: "/api/x/events", handler: named("events") });
		const response = await table.dispatch(request(table, "/api/x/events"));
		expect(await response?.text()).toBe("events");
	});

	test("the longest prefix wins", async () => {
		// `/api/a/b` is more specific than `/api/a`; letting the shorter one win
		// is an ordering defect, not a preference.
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/a", handler: named("short") });
		table.register({ kind: "prefix", path: "/api/a/b", handler: named("long") });
		const response = await table.dispatch(request(table, "/api/a/b/c"));
		expect(await response?.text()).toBe("long");
	});

	test("a prefix matches its own path and nested paths, not siblings", async () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/x", handler: named("api") });
		expect(await table.dispatch(request(table, "/api/x"))).toBeDefined();
		expect(await table.dispatch(request(table, "/api/x/y"))).toBeDefined();
		// `/api/xy` must NOT match `/api/x` — a bare startsWith would.
		expect(await table.dispatch(request(table, "/api/xy"))).toBeUndefined();
	});

	test("returns undefined when nothing claimed the path", async () => {
		// The caller needs the distinction to fall through to static/SPA serving.
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/x", handler: named("api") });
		expect(await table.dispatch(request(table, "/index.html"))).toBeUndefined();
	});

	test("a disposer removes the route", async () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		const dispose = table.register({ kind: "exact", path: "/api/x", handler: named("api") });
		expect(await table.dispatch(request(table, "/api/x"))).toBeDefined();
		dispose();
		expect(await table.dispatch(request(table, "/api/x"))).toBeUndefined();
	});

	test("disposing an older registration does not erase a newer one", async () => {
		// A plugin that replaced a path in a reload must not have its live route
		// removed when the previous instance's teardown finally runs.
		const table = new RouteTable("http://127.0.0.1:1234");
		const disposeOld = table.register({ kind: "exact", path: "/api/x", handler: named("old") });
		table.register({ kind: "exact", path: "/api/x", handler: named("new") });
		disposeOld();
		const response = await table.dispatch(request(table, "/api/x"));
		expect(await response?.text()).toBe("new");
	});

	test("rejects a path that is not absolute", () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		expect(() => table.register({ kind: "exact", path: "api/x", handler: named("x") })).toThrow(/start with/);
	});
});

describe("trust fence", () => {
	test("admits a request with no Origin", () => {
		// Same-origin navigations, same-origin GETs and non-browser clients
		// (curl, a health probe) send no Origin. The server is loopback-only.
		const table = new RouteTable("http://127.0.0.1:1234");
		expect(rejectionForOrigin(request(table, "/api/x"), table.origin)).toBeNull();
	});

	test("admits the server's own origin", () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		const req = request(table, "/api/x", { origin: "http://127.0.0.1:1234" });
		expect(rejectionForOrigin(req, table.origin)).toBeNull();
	});

	test("refuses a foreign origin", async () => {
		// Any page on the machine can reach a loopback port. A plugin's account
		// and credit data is not something an arbitrary web page may read.
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/x", handler: named("api") });
		const req = request(table, "/api/x/y", { origin: "https://evil.example" });
		const response = await table.dispatch(req);
		expect(response?.status).toBe(403);
	});

	test("refuses a different loopback port", async () => {
		// Same host, different service: still a different origin, so still foreign.
		const table = new RouteTable("http://127.0.0.1:1234");
		table.register({ kind: "prefix", path: "/api/x", handler: named("api") });
		const req = request(table, "/api/x", { origin: "http://127.0.0.1:9999" });
		const response = await table.dispatch(req);
		expect(response?.status).toBe(403);
	});

	test("refuses a malformed Origin", () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		const req = request(table, "/api/x", { origin: "not a url" });
		expect(rejectionForOrigin(req, table.origin)).toContain("invalid Origin");
	});

	test("the fence does not apply to paths no plugin claimed", async () => {
		// A foreign page loading a static asset is not a leak — there is nothing
		// secret in the renderer bundle. Only plugin routes are fenced.
		const table = new RouteTable("http://127.0.0.1:1234");
		const req = request(table, "/assets/app.js", { origin: "https://evil.example" });
		expect(await table.dispatch(req)).toBeUndefined();
	});
});
