/**
 * 插件 Web 路由的端到端契约：注册 → 命名空间作用域 → 挂载 → 请求命中。
 *
 * 守三件事，都是第三方代码（插件）与宿主之间的边界：
 * 1. **插件只在自己的命名空间内命名** —— 它无法给出 `/` 或 `/assets/x`；
 * 2. **路由跟随装载**（重载/卸载会摘掉旧路由，不留悬挂处理器）；
 * 3. **同路径冲突被报告而不是静默覆盖**。
 */

import { describe, expect, test } from "bun:test";
import { RouteTable } from "../../daemon/web-routes";
import { namespaceOf, scopeRoute } from "./web-route-scope";

/** What the loader does at registration time, isolated: namespace + scope. */
function registerRoute(
	extensionPath: string,
	request: { kind: "exact" | "prefix"; path: string; handler: () => Response },
) {
	const namespace = namespaceOf(extensionPath);
	return scopeRoute(request, namespace);
}

const ok = () => new Response("ok");

describe("plugin route end to end", () => {
	test("a plugin's route lands under its own /api namespace", async () => {
		const table = new RouteTable("http://127.0.0.1:1234");
		const scoped = registerRoute("/plugins/node_modules/musepi-auth-hub/index.ts", {
			kind: "prefix",
			path: "/pool",
			handler: ok,
		});
		table.register(scoped);
		const response = await table.dispatch(new Request("http://127.0.0.1:1234/api/musepi-auth-hub/pool"));
		expect(response?.status).toBe(200);
	});

	test("a plugin cannot occupy the renderer entry", async () => {
		// `path: "/"` means the plugin's own root, so the site root stays the
		// host's SPA. This is the difference between a plugin and a hijack.
		const scoped = registerRoute("/plugins/x/index.ts", { kind: "exact", path: "/", handler: ok });
		expect(scoped.path).toBe("/api/x");
		expect(scoped.path).not.toBe("/");
	});

	test("the event stream and the JSON API coexist on one namespace", async () => {
		// The reference's shape: a prefix owns `/api/<ns>/*` and an exact route
		// keeps `/api/<ns>/events` for the socket. Registration order must not
		// decide — the exact route wins even when registered second.
		const table = new RouteTable("http://127.0.0.1:1234");
		const base = "/plugins/node_modules/musepi-auth-hub/index.ts";
		table.register(registerRoute(base, { kind: "prefix", path: "/", handler: () => new Response("api") }));
		table.register(registerRoute(base, { kind: "exact", path: "/events", handler: () => new Response("sse") }));
		const sse = await table.dispatch(new Request("http://127.0.0.1:1234/api/musepi-auth-hub/events"));
		expect(await sse?.text()).toBe("sse");
		const api = await table.dispatch(new Request("http://127.0.0.1:1234/api/musepi-auth-hub/pool"));
		expect(await api?.text()).toBe("api");
	});

	test("unloading the extension removes its routes", async () => {
		// The daemon reconciles on every load: a reloaded/uninstalled plugin must
		// not leave a handler bound to the port.
		const table = new RouteTable("http://127.0.0.1:1234");
		const scoped = registerRoute("/plugins/x/index.ts", { kind: "prefix", path: "/pool", handler: ok });
		const dispose = table.register(scoped);
		expect(await table.dispatch(new Request("http://127.0.0.1:1234/api/x/pool"))).toBeDefined();
		dispose();
		expect(await table.dispatch(new Request("http://127.0.0.1:1234/api/x/pool"))).toBeUndefined();
	});

	test("two packages cannot derive the same namespace silently", async () => {
		// Distinct extension paths, distinct namespaces: the collision the
		// service's owner map catches is visible here as different prefixes.
		expect(namespaceOf("/plugins/a/index.ts")).not.toBe(namespaceOf("/plugins/b/index.ts"));
	});
});
