/**
 * 插件 Web 路由的命名空间作用域 —— 插件在结构上无法命名 `/` 或 `/assets/*`。
 *
 * 守的是一条安全契约：路由表的路径来自第三方代码，若插件能给绝对路径，
 * 一个 `path: "/"` 就接管了整个 GUI 入口。本层把「插件只在 `/api/<ns>/` 内命名」
 * 变成结构事实。
 */

import { describe, expect, test } from "bun:test";
import { NamespaceRegistry, namespaceOf, PLUGIN_ROUTE_ROOT, scopeRoute } from "./web-route-scope";

const handler = async (): Promise<Response> => new Response("ok");

describe("namespaceOf", () => {
	test("derives the package directory from an entry path", () => {
		expect(namespaceOf("/home/u/.musepi/plugins/node_modules/musepi-auth-hub/index.ts")).toBe("musepi-auth-hub");
		expect(namespaceOf("C:\\x\\musepi-auth-hub\\ui\\panel.tsx")).toBe("panel");
	});

	test("an index entry names its directory, not 'index'", () => {
		// `index.ts` is not an identity — every package has one. Using it would
		// give every plugin the same namespace.
		expect(namespaceOf("/x/musepi-auth-hub/index.ts")).toBe("musepi-auth-hub");
		expect(namespaceOf("/x/stats-pills/index.js")).toBe("stats-pills");
	});

	test("collapses unsafe characters into single dashes", () => {
		// The namespace appears in a URL; uppercase would be ambiguous on a
		// case-insensitive filesystem and spaces/dots need escaping.
		expect(namespaceOf("/x/My Plugin.v2/index.ts")).toBe("my-plugin-v2");
		expect(namespaceOf("/x/a___b/index.ts")).toBe("a-b");
	});

	test("refuses to derive an empty namespace", () => {
		// An empty slug would put the plugin at `/api/` — the shared root.
		expect(() => namespaceOf("/x/---/index.ts")).toThrow(/cannot derive/);
		expect(() => namespaceOf("index.ts")).toThrow(/cannot derive/);
	});
});

describe("scopeRoute", () => {
	test("mounts a route under the plugin's own namespace", () => {
		const scoped = scopeRoute({ kind: "exact", path: "/events", handler }, "auth-hub");
		expect(scoped.path).toBe("/api/auth-hub/events");
	});

	test("the namespace root is reachable", () => {
		// `path: "/"` means "my namespace root", never the site root.
		const scoped = scopeRoute({ kind: "prefix", path: "/", handler }, "auth-hub");
		expect(scoped.path).toBe("/api/auth-hub");
		expect(scoped.path).not.toBe("/");
	});

	test("a plugin cannot reach outside its namespace", () => {
		// These are the shapes that would let a handler answer for the SPA entry
		// or for another origin's resources.
		for (const path of ["//evil", "/../x", "/a/../..", "/a\\b"]) {
			expect(() => scopeRoute({ kind: "exact", path, handler }, "auth-hub"), path).toThrow();
		}
	});

	test("rejects a relative path", () => {
		expect(() => scopeRoute({ kind: "exact", path: "events", handler }, "auth-hub")).toThrow(/start with/);
	});

	test("every scoped path starts with the plugin root", () => {
		// The invariant, not a sample: whatever a plugin names, the result lives
		// under the plugin prefix.
		for (const path of ["/", "/a", "/a/b/c"]) {
			const scoped = scopeRoute({ kind: "prefix", path, handler }, "ns");
			expect(scoped.path.startsWith(`${PLUGIN_ROUTE_ROOT}/ns`), path).toBe(true);
		}
	});
});

describe("NamespaceRegistry", () => {
	test("one namespace has one owner", () => {
		const registry = new NamespaceRegistry();
		expect(registry.claim("auth-hub", "plugin-a")).toBe("/api/auth-hub");
		expect(() => registry.claim("auth-hub", "plugin-b")).toThrow(/already claimed/);
	});

	test("the same owner may re-claim (a reload is not a conflict)", () => {
		const registry = new NamespaceRegistry();
		registry.claim("auth-hub", "plugin-a");
		expect(() => registry.claim("auth-hub", "plugin-a")).not.toThrow();
	});

	test("releasing frees the namespace for another owner", () => {
		const registry = new NamespaceRegistry();
		registry.claim("auth-hub", "plugin-a");
		registry.release("auth-hub", "plugin-a");
		expect(() => registry.claim("auth-hub", "plugin-b")).not.toThrow();
	});

	test("releasing as a non-owner does not free it", () => {
		// A stale teardown from a replaced plugin must not evict the live owner.
		const registry = new NamespaceRegistry();
		registry.claim("auth-hub", "plugin-a");
		registry.release("auth-hub", "plugin-b");
		expect(registry.owners().get("auth-hub")).toBe("plugin-a");
	});
});
