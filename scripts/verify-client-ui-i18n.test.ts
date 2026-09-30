import { describe, expect, test } from "bun:test";
import { findUiI18nViolations } from "./verify-client-ui-i18n";

/**
 * The hard-coded copy gate (dsh verify-client-ui-i18n parity). The contract:
 * locale dictionaries under src/i18n are the only files allowed to hold
 * product copy; display code must obtain it via t() or localized props. The
 * gate must flag JSX text, copy-bearing attributes, copy-named variables and
 * string returns — and must NOT flag t() calls, locale-key literals, or
 * single non-CJK glyphs (the "v" version prefix is a symbol, not copy).
 */

const FILE = "packages/desktop-app/src/components/probe.tsx";

function probe(source: string) {
	return findUiI18nViolations(FILE, source);
}

describe("findUiI18nViolations", () => {
	test("flags hard-coded English JSX text", () => {
		const vs = probe(`export function X() { return <button>Save changes</button>; }`);
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("JSX text");
		expect(vs[0]?.text).toBe("Save changes");
	});

	test("flags hard-coded Chinese JSX text", () => {
		const vs = probe(`export function X() { return <span>保存更改</span>; }`);
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("JSX text");
	});

	test("flags a copy-bearing label attribute", () => {
		const vs = probe(`export function X() { return <input label="Display name" />; }`);
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("label attribute");
		expect(vs[0]?.text).toBe("Display name");
	});

	test("flags a natural-text template literal as JSX child", () => {
		const vs = probe("export function X({ name }: { name: string }) { return <p>{`Hello ${name}`}</p>; }");
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("JSX child");
	});

	test("flags a copy-named variable initialized with a literal", () => {
		const vs = probe(`const closeLabel = "Close"; export { closeLabel };`);
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("closeLabel value");
	});

	test("flags a string literal returned from a copy-named function", () => {
		const vs = probe(`export function emptyLabel() { return "Nothing here"; }`);
		expect(vs).toHaveLength(1);
		expect(vs[0]?.reason).toBe("emptyLabel return value");
	});

	test("accepts t() calls in JSX children and copy attributes", () => {
		const vs = probe(`export function X() { return <button aria-label={t("save")}>{t("save")}</button>; }`);
		expect(vs).toHaveLength(0);
	});

	test("accepts locale-key-style JSX text", () => {
		const vs = probe(`export function X() { return <code>ext.plugins.official</code>; }`);
		expect(vs).toHaveLength(0);
	});

	test("accepts a lone non-CJK glyph (version prefix is a symbol, not copy)", () => {
		const vs = probe("export function X({ version }: { version: string }) { return <span>{`v${version}`}</span>; }");
		expect(vs).toHaveLength(0);
	});

	test("accepts variable interpolation inside a t() call", () => {
		const vs = probe(`export function X({ n }: { n: number }) { return <p>{t("plugin counts", { n })}</p>; }`);
		expect(vs).toHaveLength(0);
	});

	test("does not flag non-copy variable names holding literals", () => {
		// By design only copy-named bindings are inspected; a plain `token`
		// carrying a non-copy value stays out of scope.
		const vs = probe(`const CSS_CLASS = "gui-card"; export { CSS_CLASS };`);
		expect(vs).toHaveLength(0);
	});
});
