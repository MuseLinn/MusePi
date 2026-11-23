#!/usr/bin/env bun

/**
 * Gate: every literal RPC method name a GUI client sends must name a route the
 * host actually dispatches.
 *
 * The wire contract is a bare string on both sides — `rpc.request("x.y")` on
 * the caller, `case "x.y":` in a dispatch switch — so a bulk edit that rewrites
 * identifiers (the i18n sweep that turned `session.setModel` into
 * `settings.sessionSetmodel`) compiles clean and fails only at runtime, where
 * the caller often swallows the rejection. This gate compares the two sides.
 *
 * Route sources, parsed from the dispatch switches rather than a second
 * hand-maintained list so a renamed or removed route is covered without
 * touching this file:
 * - `DaemonServer.handle` (desktop/CLI daemon, WS JSON-RPC);
 * - `CollabHost.#rpcDispatch` (guest link over the collab relay).
 *
 * Callers are every GUI surface that speaks the host contract:
 * - `RpcClient.request` in `apps/desktop/src` and `packages/client-core/src`;
 * - `SessionClient.rpc` over the collab relay;
 * - the bundled plugin panels under `packages/coding-agent/src/plugins`,
 *   which draw their panels through the same daemon methods.
 * Only values that can become the method argument are read — a literal and the
 * arms of a selector, or a local `const method = …` the call passes through.
 * A name that reaches the call through a prop or another module's parameter is
 * not traced; the caller that supplies it is the place to look.
 *
 * `ROUTE_LISTS` covers the one form that carries route names without a
 * `.request()` call: a client-side list of methods it probes before trusting
 * the daemon. Those names are validated against the same route set.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_ROOT = join(import.meta.dir, "..");
const ROUTE_SOURCES = [
	// [file, dispatcher signature, switch marker]
	["packages/coding-agent/src/daemon/server.ts", "handle(method: string", "switch (method)"],
	["packages/coding-agent/src/collab/host.ts", "#rpcDispatch(method: string", "switch (method)"],
] as const;
/** GUI surfaces that speak a host RPC contract. */
export const CLIENT_ROOTS = ["apps/desktop/src", "packages/client-core/src", "packages/coding-agent/src/plugins"];
/** Route-name arrays a client relies on without sending them inline. */
export const ROUTE_LISTS = [
	{ file: "apps/desktop/src/lib/daemon-version.ts", exported: "REQUIRED_DAEMON_METHODS" },
] as const;
/** The calls that carry a route name on these clients. */
const RPC_CALL = /\.(?:request|rpc)\s*(?:<[^;()]*?>)?\s*\(/g;
const SOURCE_FILE = /\.(ts|tsx)$/;
/** Tests drive mock clients, where a fake route is legitimate. */
const TEST_FILE = /\.(test|spec)\.tsx?$/;

/** A literal method name with every place a client sends it. */
export interface ClientMethodUse {
	method: string;
	places: string[];
}

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

function* walkSources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walkSources(path);
		else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) yield path;
	}
}

/** Index of the bracket closing the one at `open`, or -1. */
function closingIndex(text: string, open: number): number {
	const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
	const opener = text[open];
	const closer = pairs[opener];
	if (!closer) return -1;
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (ch === opener) depth++;
		else if (ch === closer) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Top-level comma in a call argument list, or -1 when there is one argument. */
function firstArgumentEnd(text: string): number {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) return i;
	}
	return text.length;
}

/** A lone string literal, unwrapping redundant parentheses. */
function loneLiteral(expression: string): string | null {
	let text = expression.trim();
	while (text.startsWith("(") && text.endsWith(")") && closingIndex(text, 0) === text.length - 1) {
		text = text.slice(1, -1).trim();
	}
	if (text.length < 2) return null;
	const quote = text[0];
	if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) return null;
	const inner = text.slice(1, -1);
	if (inner.includes(quote)) return null;
	return inner;
}

/** Split an expression at its top-level `?` and `:` (a conditional's arms). */
function ternaryArms(expression: string): [string, string] | null {
	let depth = 0;
	let question = -1;
	for (let i = 0; i < expression.length; i++) {
		const ch = expression[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "?" && depth === 0) {
			// `??`, `?.` and `?:` are not a conditional.
			const next = expression[i + 1];
			if (next === "?" || next === "." || next === ":") continue;
			question = i;
			break;
		}
	}
	if (question < 0) return null;
	let depth2 = 0;
	for (let i = question + 1; i < expression.length; i++) {
		const ch = expression[i];
		if (ch === "(" || ch === "[" || ch === "{") depth2++;
		else if (ch === ")" || ch === "]" || ch === "}") depth2--;
		else if (ch === ":" && depth2 === 0) return [expression.slice(question + 1, i), expression.slice(i + 1)];
	}
	return null;
}

/**
 * Method names an argument expression can evaluate to. Only value positions
 * count: the condition of a selector (`action === "install" ? …`) names a UI
 * state, not a route, so it must not be read as a method name.
 */
export function methodLiterals(expression: string): string[] {
	const literal = loneLiteral(expression);
	if (literal !== null) return [literal];
	const arms = ternaryArms(expression);
	if (arms === null) return [];
	return [...methodLiterals(arms[0]), ...methodLiterals(arms[1])];
}

/** Initializer of a local `const`/`let` binding, up to its terminating `;`. */
function localInitializer(text: string, name: string): string | null {
	const declaration = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*(?::[^=;]+)?=`).exec(text);
	if (!declaration) return null;
	const start = declaration.index + declaration[0].length;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === ";" && depth === 0) return text.slice(start, i);
	}
	return null;
}

/** Route names a dispatch switch answers, depth-0 case labels only. */
export function dispatchedRoutes(root: string): Set<string> {
	const routes = new Set<string>();
	for (const [file, signature, marker] of ROUTE_SOURCES) {
		const path = join(root, file);
		if (!existsSync(path)) throw new Error(`${file}: route source missing`);
		const text = readFileSync(path, "utf8");
		const signatureAt = text.indexOf(signature);
		if (signatureAt < 0) throw new Error(`${file}: dispatcher signature not found`);
		const switchAt = text.indexOf(marker, signatureAt);
		if (switchAt < 0) throw new Error(`${file}: switch (method) not found`);
		const bodyOpen = text.indexOf("{", switchAt);
		const bodyClose = closingIndex(text, bodyOpen);
		if (bodyClose < 0) throw new Error(`${file}: unclosed dispatcher switch`);
		// Nested switches inside a case body name nothing on the wire.
		const body = text.slice(bodyOpen + 1, bodyClose);
		let depth = 0;
		let topLevel = "";
		for (const ch of body) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			if (depth === 0) topLevel += ch;
		}
		for (const match of topLevel.matchAll(/case\s+"([^"]+)"/g)) routes.add(match[1]);
	}
	return routes;
}

/** Literal method names the clients send, keyed by route. */
export function clientMethods(root: string): Map<string, string[]> {
	const uses = new Map<string, string[]>();
	const record = (method: string, place: string): void => {
		const places = uses.get(method) ?? [];
		if (!places.includes(place)) places.push(place);
		uses.set(method, places);
	};
	for (const clientRoot of CLIENT_ROOTS) {
		const dir = join(root, clientRoot);
		if (!existsSync(dir)) continue;
		for (const file of walkSources(dir)) {
			const text = readFileSync(file, "utf8");
			const rel = toPosix(relative(root, file));
			for (const call of text.matchAll(RPC_CALL)) {
				const open = call.index + call[0].length - 1;
				const close = closingIndex(text, open);
				if (close < 0) continue;
				const args = text.slice(open + 1, close);
				const first = args.slice(0, firstArgumentEnd(args)).trim();
				const line = text.slice(0, call.index).split("\n").length;
				const place = `${rel}:${line}`;
				const direct = methodLiterals(first);
				if (direct.length > 0) {
					for (const method of direct) record(method, place);
					continue;
				}
				// A selector may be hoisted into a local binding first
				// (`const method = cond ? "a.b" : "c.d"; rpc.request(method, …)`).
				if (/^[A-Za-z_$][\w$]*$/.test(first)) {
					const initializer = localInitializer(text, first);
					if (initializer !== null) for (const method of methodLiterals(initializer)) record(method, place);
				}
			}
		}
	}
	return uses;
}

/** Route names a client declares in an array literal (probe/capability lists). */
export function declaredMethods(root: string): Map<string, string[]> {
	const uses = new Map<string, string[]>();
	for (const { file, exported } of ROUTE_LISTS) {
		const path = join(root, file);
		if (!existsSync(path)) throw new Error(`${file}: route-name list source missing`);
		const text = readFileSync(path, "utf8");
		const declaration = new RegExp(`export\\s+const\\s+${exported}\\s*(?::[^=]+)?=`).exec(text);
		if (!declaration) throw new Error(`${file}: ${exported} not found`);
		const open = text.indexOf("[", declaration.index + declaration[0].length);
		const close = open < 0 ? -1 : closingIndex(text, open);
		if (open < 0 || close < 0) throw new Error(`${file}: ${exported} is not an array literal`);
		// Blank comments in place so a quoted word in prose is not read as a route
		// and offsets still map back to the original lines.
		const body = text
			.slice(open + 1, close)
			.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "))
			.replace(/\/\/[^\n]*/g, comment => " ".repeat(comment.length));
		for (const match of body.matchAll(/"([^"]+)"/g)) {
			const line = text.slice(0, open + 1 + match.index).split("\n").length;
			const place = `${file}:${line} (${exported})`;
			const places = uses.get(match[1]) ?? [];
			if (!places.includes(place)) places.push(place);
			uses.set(match[1], places);
		}
	}
	return uses;
}

/** Every literal route a client sends or declares, with each place it appears. */
export function methodUses(root: string): Map<string, string[]> {
	const uses = clientMethods(root);
	for (const [method, places] of declaredMethods(root)) {
		const existing = uses.get(method) ?? [];
		for (const place of places) if (!existing.includes(place)) existing.push(place);
		uses.set(method, existing);
	}
	return uses;
}

/** Literal client names with no matching route, sorted by name. */
export function unroutedMethods(
	root: string,
	known: { routes?: Set<string>; uses?: Map<string, string[]> } = {},
): ClientMethodUse[] {
	const routes = known.routes ?? dispatchedRoutes(root);
	const uses = known.uses ?? methodUses(root);
	return [...uses.entries()]
		.filter(([method]) => !routes.has(method))
		.map(([method, places]) => ({ method, places }))
		.sort((a, b) => a.method.localeCompare(b.method));
}

function main(): number {
	const root = process.env.RPC_METHOD_ROOT ? resolve(process.env.RPC_METHOD_ROOT) : DEFAULT_ROOT;
	const routes = dispatchedRoutes(root);
	const uses = methodUses(root);
	const unrouted = unroutedMethods(root, { routes, uses });
	if (unrouted.length === 0) {
		console.log(`check-rpc-method-names: OK — ${uses.size} client method(s) all routed (${routes.size} routes)`);
		return 0;
	}
	console.error(`check-rpc-method-names: ${unrouted.length} client method(s) have no host route:`);
	for (const { method, places } of unrouted) {
		console.error(`  ${method}`);
		for (const place of places) console.error(`    ${place}`);
	}
	console.error("\nUse the route name from the dispatch switch, or add the route to the host.");
	return 1;
}

if (import.meta.main) process.exit(main());
