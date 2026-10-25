/**
 * 插件自有 HTTP 路由 —— 让插件在宿主已绑定的 loopback 端口上挂自己的处理器。
 *
 * ## 为什么需要这条缝
 *
 * 没有它，插件只能「被宿主调用」（`ext.call` 请求-应答）。而一个成熟插件要做
 * 的很多事都是**它自己拥有一条通路**：
 *
 * - **事件流**：服务端推送（SSE）——轮询 40 多次 `ext.call` 换成一次长连接；
 * - **路由前缀**：自己的 API 命名空间（`/api/<plugin>/*`）；
 * - **服务自己的客户端资源**：面板拆包、图标、样式；
 * - **OpenAI 兼容网关**：`/v1/chat/completions` 等对外端点；
 * - **OAuth 回环回调**：登录流程需要本机 callback URL。
 *
 * ## 派发顺序
 *
 * 1. **精确**路由：`Map` 查表，O(1)；
 * 2. **前缀**路由：**最长前缀优先**（不是注册顺序）——`/api/a/b` 比 `/api/a` 更具体，
 *    让它被短前缀截胡是排序缺陷；
 * 3. 未被任何插件接管 ⇒ 交回静态服务（含 SPA 回退）。
 *
 * ⚠️ 精确**优先于**前缀，而不是按注册时间混排：事件流用 `kind:'exact'`
 * 拿到 `/api/<ns>/events`，而 JSON API 用 `kind:'prefix'` 覆盖 `/api/<ns>/*`。
 * 若按时间排，先注册的前缀会把后面的事件流整条吃掉（socket 永远进不了流式处理器）。
 *
 * ## 信任围栏
 *
 * 服务绑在 loopback，但**本机上的任意网页**都能向它发请求（浏览器不区分
 * 「本机」与「可信」）。插件路由因此只接受：
 *
 * - **没有 `Origin` 头**的请求：同源导航、`curl`、以及同源 `fetch` 的 GET；
 * - `Origin` 与**本服务的 origin 相同**的请求。
 *
 * 其余一律 403。跨源一律拒绝而不是只读放行：「读」也能泄露账号状态与用量。
 *
 * ⚠️ 这是**纵深防御的一道**，不是唯一防线：插件仍必须自己校验自己的输入
 * （本服务的职责是「别把插件的 API 暴露给任意网页」，不是替插件做鉴权）。
 */

/** One registered route handler. */
export type WebRouteHandler = (req: Request) => Response | Promise<Response>;

/** Route matching strategy. */
export type WebRouteKind = "exact" | "prefix";

export interface WebRoute {
	readonly kind: WebRouteKind;
	readonly path: string;
	readonly handler: WebRouteHandler;
}

/** The registration surface handed to a plugin. */
export interface WebRouteRegistry {
	/**
	 * Claim a path. Returns a disposer that removes it — call it from the
	 * plugin's teardown, or a reload leaves a stale handler bound to the port.
	 */
	register(route: WebRoute): () => void;
	/** Slots currently claimed (diagnostics / tests). */
	routes(): readonly WebRoute[];
	/** The origin this server is reachable at, for building absolute URLs. */
	readonly origin: string;
}

/** Why a request was refused; `null` = admitted. */
export function rejectionForOrigin(req: Request, origin: string): string | null {
	const raw = req.headers.get("origin");
	// No Origin header: a same-origin navigation, a fetch from the page this
	// server itself served (GET does not send Origin), or a non-browser client
	// (curl, a health probe). Admitted — the server is loopback-only.
	if (raw === null || raw === "") return null;
	let parsed: string;
	try {
		parsed = new URL(raw).origin;
	} catch {
		return `invalid Origin: ${raw}`;
	}
	// Compare origins, not strings: `http://127.0.0.1:1234/` and a trailing
	// slash or explicit default port must not be treated as foreign.
	if (parsed === origin) return null;
	return `cross-origin request from ${parsed}`;
}

/** The route table behind a running web server. */
export class RouteTable implements WebRouteRegistry {
	readonly origin: string;
	readonly #exact = new Map<string, WebRouteHandler>();
	#prefixes: Array<{ path: string; handler: WebRouteHandler }> = [];

	constructor(origin: string) {
		this.origin = origin;
	}

	register(route: WebRoute): () => void {
		const { kind, path: routePath, handler } = route;
		if (routePath === "" || !routePath.startsWith("/")) {
			throw new Error(`web route path must start with "/": ${routePath}`);
		}
		if (kind === "exact") {
			this.#exact.set(routePath, handler);
			return () => {
				// Only delete when the installed handler is still ours: a later
				// registration may have replaced the path, and disposing the newer
				// one from an older plugin's teardown would erase live routing.
				if (this.#exact.get(routePath) === handler) this.#exact.delete(routePath);
			};
		}
		this.#prefixes.push({ path: routePath, handler });
		// Longest first, so `/api/a/b` is tried before `/api/a`.
		this.#prefixes.sort((a, b) => b.path.length - a.path.length);
		return () => {
			this.#prefixes = this.#prefixes.filter(entry => entry.handler !== handler);
		};
	}

	routes(): readonly WebRoute[] {
		return [
			...[...this.#exact.entries()].map(([path, handler]) => ({ kind: "exact" as const, path, handler })),
			...this.#prefixes.map(({ path, handler }) => ({
				kind: "prefix" as const,
				path,
				handler,
			})),
		];
	}

	/**
	 * Dispatch one request, or return `undefined` to let the caller continue
	 * with its own handling (static file / SPA fallback).
	 *
	 * The origin check runs only when a plugin route actually matched: a foreign
	 * page asking for a static asset gets the asset (there is nothing secret in
	 * the renderer bundle), while the same page asking for plugin data is
	 * refused.
	 */
	async dispatch(req: Request): Promise<Response | undefined> {
		const { pathname } = new URL(req.url);
		const exact = this.#exact.get(pathname);
		if (exact !== undefined) {
			return this.#guard(req, pathname, exact);
		}
		for (const { path: prefix, handler } of this.#prefixes) {
			if (pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
				return this.#guard(req, pathname, handler);
			}
		}
		return undefined;
	}

	async #guard(req: Request, pathname: string, handler: WebRouteHandler): Promise<Response> {
		const rejection = rejectionForOrigin(req, this.origin);
		if (rejection !== null) {
			return new Response(JSON.stringify({ error: rejection }), {
				status: 403,
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}
		void pathname;
		return await handler(req);
	}
}
