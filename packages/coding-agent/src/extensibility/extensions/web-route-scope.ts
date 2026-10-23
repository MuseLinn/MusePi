/**
 * 插件 Web 路由的**路径作用域** —— 插件不能抢占它不该拥有的路径。
 *
 * ## 为什么必须有这一层
 *
 * 路由表（`web-routes.ts`）只负责派发，它信任调用者给的路径。但路径来自插件，
 * 而插件是第三方代码：一个写成 `registerWebRoute({ kind: 'exact', path: '/' })`
 * 的插件会**接管整个 GUI 入口**——宿主自己服务的 SPA 再也回不去，用户看到的是
 * 插件的处理器返回的东西。同理 `/assets/*` 前缀会吃掉渲染器的静态资源。
 *
 * ⇒ 插件**不给绝对路径**。它给的是**自己命名空间内的相对路径**，宿主负责拼上
 * 前缀。这样插件在结构上就无法命名 `/` 或 `/assets/x`。
 *
 * ## 命名空间从哪来
 *
 * 从扩展身份派生（入口路径 → 名称），并做字符白名单化：命名空间要出现在 URL 里，
 * 任何非 `[a-z0-9-]` 的字符都会带来歧义（大小写不敏感的文件系统、URL 转义、
 * 路径穿越）。派生结果对同一插件**稳定**——重载前后一致，否则客户端记下的
 * 地址会失效。
 *
 * ## 冲突
 *
 * 两个插件派生出同一命名空间时**后者不覆盖前者**：抛错。静默覆盖会让先注册的
 * 插件的数据面被另一个插件的处理器接管（它的客户端仍去那儿取数据）。
 */

/** 插件可用的路由类型。与 `web-routes.ts` 的 `WebRouteKind` 同值。 */
export type PluginRouteKind = "exact" | "prefix";

/** 插件注册时提供的路由（路径是**命名空间内**的相对路径）。 */
export interface PluginWebRouteRequest {
	readonly kind: PluginRouteKind;
	/** 命名空间内的路径，必须以 `/` 开头（`/summary`、`/events`、`/`）。 */
	readonly path: string;
	readonly handler: (req: Request) => Response | Promise<Response>;
}

/** 派生后的路由：宿主拼好的绝对路径。 */
export interface ScopedWebRoute {
	readonly kind: PluginRouteKind;
	readonly path: string;
	readonly handler: (req: Request) => Response | Promise<Response>;
}

/** The namespace prefix every plugin route lives under. */
export const PLUGIN_ROUTE_ROOT = "/api";

/**
 * 从一个扩展身份派生 URL 命名空间。
 *
 * 输入是扩展的入口路径或名字；输出是稳定的 `[a-z0-9-]` 串。算法：
 * 1. 取最后一段（`…/musepi-auth-hub/index.ts` → `musepi-auth-hub`；`index.ts` 取父目录）；
 * 2. 去扩展名；
 * 3. 小写，非 `[a-z0-9]` 折叠成单个 `-`，去首尾 `-`；
 * 4. 空结果 ⇒ 抛错（宁可插件装不上，也不要它拿到 `/api/` 这个共用根）。
 */
export function namespaceOf(extensionIdentity: string): string {
	const normalized = extensionIdentity.replace(/\\/g, "/");
	const segments = normalized.split("/").filter(segment => segment.length > 0);
	const last = segments[segments.length - 1] ?? "";
	const withoutExt = last.replace(/\.[a-z0-9]+$/i, "");
	// `index.ts` names the DIRECTORY it sits in: the entry file is not an identity.
	const candidate = withoutExt === "index" ? (segments[segments.length - 2] ?? "") : withoutExt;
	const slug = candidate
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug === "") {
		throw new Error(`cannot derive a URL namespace from "${extensionIdentity}"`);
	}
	return slug;
}

/**
 * 把一个插件路由请求拼成绝对路径。
 *
 * ⚠️ 路径**只允许**在命名空间内：`/` 合法（= 命名空间根），`//x`、`/\x`、
 * `../x` 一律拒绝。目的是让「插件处理器的路径不可能落在 `/` 或 `/assets` 下」
 * 成为**结构事实**，而不是一条需要记得遵守的约定。
 */
export function scopeRoute(request: PluginWebRouteRequest, namespace: string): ScopedWebRoute {
	const routePath = request.path;
	if (routePath === "" || !routePath.startsWith("/")) {
		throw new Error(`plugin route path must start with "/": ${routePath}`);
	}
	// `//` would produce a scheme-relative-looking path; `..` / `\` are traversal
	// shapes that must never reach the router.
	if (routePath.startsWith("//") || routePath.includes("..") || routePath.includes("\\")) {
		throw new Error(`plugin route path must not contain "//", ".." or "\\": ${routePath}`);
	}
	const base = `${PLUGIN_ROUTE_ROOT}/${namespace}`;
	const absolute = routePath === "/" ? base : `${base}${routePath}`;
	return { kind: request.kind, path: absolute, handler: request.handler };
}

/**
 * 命名空间占用表 —— 同一命名空间只能有一个所有者。
 *
 * 覆盖**不**静默发生：先注册的插件的客户端仍会去 `/api/<ns>/*` 取数据，被后者的
 * 处理器接管意味着它的数据面「消失」但没有任何报错。
 */
export class NamespaceRegistry {
	readonly #owners = new Map<string, string>();

	/** @returns 该命名空间的绝对根路径。 */
	claim(namespace: string, owner: string): string {
		const existing = this.#owners.get(namespace);
		if (existing !== undefined && existing !== owner) {
			throw new Error(`web namespace "${namespace}" is already claimed by ${existing}; ${owner} must use its own`);
		}
		this.#owners.set(namespace, owner);
		return `${PLUGIN_ROUTE_ROOT}/${namespace}`;
	}

	release(namespace: string, owner: string): void {
		if (this.#owners.get(namespace) === owner) this.#owners.delete(namespace);
	}

	owners(): ReadonlyMap<string, string> {
		return this.#owners;
	}
}
