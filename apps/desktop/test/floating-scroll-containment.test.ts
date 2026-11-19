import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Floating surfaces own their scroll chain.
 *
 * A wheel gesture that reaches the end of a dropdown, popover, picker or
 * dialog body keeps travelling up the scroll chain unless the surface itself
 * says `overscroll-behavior: contain`. The page root is not a substitute: the
 * `overscroll-behavior-y: none` on `html`/`body` stops the browser viewport,
 * not a nested scroller handing the gesture to its scroll ancestor — which is
 * what moved the transcript behind an open menu. The shell already contains
 * the toasts and the sessions sheet (`.sh-toast-msg`, `.ss-list`); this list
 * is the rest of the floating surfaces.
 *
 * Page-level scrollers are deliberately absent: the transcript, the chat
 * column and the sidebars must keep chaining to their own parents.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

type Kind = "menu" | "popover" | "picker" | "palette" | "dialog" | "overlay";

interface Surface {
	/** Stylesheet relative to the repo root. */
	file: string;
	/** Exact selector of the floating surface's own scroll box. */
	selector: string;
	kind: Kind;
	/** The surface is rendered through a portal, so its DOM ancestry is the
	 *  app root, not the component that opened it — containment cannot live
	 *  on a parent component's scroller. */
	portal: boolean;
	/** Set when the box only becomes a scroller inside this at-rule. */
	media?: string;
}

const SURFACES: readonly Surface[] = [
	{ file: "apps/desktop/src/styles/gui-chat.css", selector: ".gui-header-title-menu", kind: "menu", portal: false },
	{
		file: "apps/desktop/src/styles/gui-composer.css",
		selector: ".gui-attach-picker-list",
		kind: "picker",
		portal: true,
	},
	{ file: "apps/desktop/src/styles/gui-composer.css", selector: ".gui-connector-panel", kind: "picker", portal: true },
	{ file: "apps/desktop/src/styles/gui-misc.css", selector: ".gui-btw-body", kind: "overlay", portal: true },
	{ file: "apps/desktop/src/styles/gui-misc.css", selector: ".gui-project-dialog-body", kind: "dialog", portal: true },
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-dialog--settings",
		kind: "dialog",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-dialog.gui-dialog--models",
		kind: "dialog",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-dialog.gui-dialog--connector",
		kind: "dialog",
		portal: true,
	},
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-model-list", kind: "menu", portal: true },
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-model-menu--compact",
		kind: "menu",
		portal: true,
	},
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-context-menu", kind: "menu", portal: true },
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-slash-menu", kind: "menu", portal: false },
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-queue-panel", kind: "popover", portal: true },
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-proj-menu", kind: "menu", portal: true },
	{ file: "apps/desktop/src/styles/gui-settings.css", selector: ".gui-palette-body", kind: "palette", portal: true },
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-plugin-dialog-body",
		kind: "dialog",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-settings-search-pop-results",
		kind: "popover",
		portal: true,
		media: "@media (max-width: 900px)",
	},
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-browser-suggestions",
		kind: "popover",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-settings.css",
		selector: ".gui-browser-extensions-popup",
		kind: "popover",
		portal: true,
	},
	{ file: "apps/desktop/src/styles/gui-taskcenter.css", selector: ".gui-select-menu", kind: "menu", portal: true },
	{
		file: "apps/desktop/src/styles/gui-taskcenter.css",
		selector: ".gui-tray-menu__scroll",
		kind: "popover",
		portal: false,
	},
	{
		file: "apps/desktop/src/styles/gui-workspace.css",
		selector: ".gui-swarm-popup-card",
		kind: "popover",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-workspace.css",
		selector: ".gui-prboard-picker-menu",
		kind: "menu",
		portal: false,
	},
	{
		file: "apps/desktop/src/styles/gui-workspace.css",
		selector: ".gui-cap-drawer-body",
		kind: "overlay",
		portal: true,
	},
	{
		file: "apps/desktop/src/styles/gui-workspace.css",
		selector: ".tr-branch-list--open",
		kind: "menu",
		portal: false,
	},
	{ file: "apps/desktop/src/styles/gui-chrome.css", selector: ".gui-shortcuts-grid", kind: "dialog", portal: true },
	{
		file: "apps/desktop/src/styles/gui-chrome.css",
		selector: ".gui-instance-manager-body",
		kind: "dialog",
		portal: true,
	},
	{
		file: "packages/client-core/src/components/shell/shell.css",
		selector: ".sh-switcher-pop.sh-panel-menu-pop",
		kind: "popover",
		portal: true,
	},
	{
		file: "packages/client-core/src/components/shell/shell.css",
		selector: ".sh-host-manager-list",
		kind: "dialog",
		portal: true,
	},
	{
		file: "packages/client-core/src/components/transcript/transcript.css",
		selector: ".tr-mm-lb-scroll",
		kind: "overlay",
		portal: true,
	},
	{
		file: "packages/client-core/src/components/agents/agents.css",
		selector: ".ag-drawer-body",
		kind: "overlay",
		portal: true,
	},
];

/**
 * Page-level scroll boxes. They must keep chaining: their ancestor is the
 * shell, not the page root, and a transcript that swallows the wheel at its
 * own edge would strand touch users inside the chat.
 *
 * `.gui-transcript` is the real chat scroller (`ChatView.tsx:3401` carries
 * Tailwind `overflow-y-auto`); the `.gui-chat-scroll` rule in gui-chrome.css
 * has no consumer and is not what these tests are guarding.
 */
const PAGE_SCROLLERS = [
	{ file: "apps/desktop/src/styles/gui-chat.css", selector: ".gui-transcript" },
	{ file: "packages/client-core/src/components/transcript/transcript.css", selector: ".tr-root" },
	{ file: "apps/desktop/src/styles/gui-chat.css", selector: ".gui-right-rail-scroll" },
	{ file: "packages/client-core/src/components/shell/shell.css", selector: ".sh-ws-sidebar" },
	{ file: "packages/client-core/src/components/shell/shell.css", selector: ".sh-panel" },
] as const;

interface Rule {
	selector: string;
	declarations: Map<string, string>;
	atRules: readonly string[];
	order: number;
}

/** Comments name the old behaviour, so they must not satisfy an assertion. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in a sheet with the at-rules it is nested in. At-rule preludes
 * are tracked with a brace stack so `@media` bodies do not lose their
 * condition and declarations inside them are distinguishable from base rules.
 */
function parseRules(css: string): Rule[] {
	const rules: Rule[] = [];
	const atRules: string[] = [];
	let preludeStart = 0;
	let index = 0;
	while (index < css.length) {
		const char = css[index]!;
		if (char === "{") {
			const prelude = css.slice(preludeStart, index).trim();
			if (prelude.startsWith("@")) {
				atRules.push(prelude);
				index++;
				preludeStart = index;
				continue;
			}
			let depth = 1;
			let end = index + 1;
			while (end < css.length && depth > 0) {
				if (css[end] === "{") depth++;
				else if (css[end] === "}") depth--;
				end++;
			}
			const declarations = new Map<string, string>();
			for (const raw of css.slice(index + 1, end - 1).split(";")) {
				const separator = raw.indexOf(":");
				if (separator === -1) continue;
				declarations.set(raw.slice(0, separator).trim(), raw.slice(separator + 1).trim());
			}
			rules.push({ selector: prelude, declarations, atRules: [...atRules], order: rules.length });
			index = end;
			preludeStart = index;
			continue;
		}
		if (char === ";") {
			preludeStart = index + 1;
			index++;
			continue;
		}
		if (char === "}") {
			atRules.pop();
			index++;
			preludeStart = index;
			continue;
		}
		index++;
	}
	return rules;
}

const SHEETS = new Map<string, Rule[]>();
function rulesOf(file: string): Rule[] {
	let rules = SHEETS.get(file);
	if (rules === undefined) {
		const absolute = path.join(REPO_ROOT, file);
		rules = parseRules(stripComments(fs.readFileSync(absolute, "utf8")));
		SHEETS.set(file, rules);
	}
	return rules;
}

const selectorList = (rule: Rule): string[] => rule.selector.split(",").map(part => part.trim());
const declares = (rule: Rule, selector: string): boolean => selectorList(rule).includes(selector);

const isScroller = (value: string | undefined): boolean => value !== undefined && /(auto|scroll|overlay)/.test(value);

/** A rule that both makes the box scroll and contains the chain. */
function containmentRules(file: string, selector: string): Rule[] {
	return rulesOf(file).filter(
		rule =>
			declares(rule, selector) &&
			(rule.declarations.get("overscroll-behavior") === "contain" ||
				(rule.declarations.get("overscroll-behavior-y") === "contain" &&
					rule.declarations.get("overscroll-behavior-x") === "contain")),
	);
}

const rulesFor = (file: string, selector: string): Rule[] => rulesOf(file).filter(rule => declares(rule, selector));

describe("floating surfaces contain their scroll chain", () => {
	for (const surface of SURFACES) {
		const label = `${surface.selector} (${surface.kind}${surface.portal ? ", portaled" : ""})`;

		test(`${label} declares overscroll-behavior: contain`, () => {
			const rules = containmentRules(surface.file, surface.selector);
			expect(rules.length, `${surface.selector} has no containment rule in ${surface.file}`).toBeGreaterThan(0);
			if (surface.media !== undefined) {
				expect(
					rules.some(rule => rule.atRules.includes(surface.media!)),
					`${surface.selector} is only a scroller inside ${surface.media}`,
				).toBe(true);
			} else {
				expect(
					rules.some(rule => rule.atRules.length === 0),
					`${surface.selector} containment must apply unconditionally`,
				).toBe(true);
			}
		});

		test(`${label} is still a vertical scroller after the change`, () => {
			const scroller = rulesFor(surface.file, surface.selector).some(
				rule => isScroller(rule.declarations.get("overflow-y")) || isScroller(rule.declarations.get("overflow")),
			);
			expect(scroller, `${surface.selector} no longer scrolls — containment would be moot`).toBe(true);
		});
	}

	test("every sheet parses and the canary selector is found", () => {
		for (const file of new Set(SURFACES.map(surface => surface.file))) {
			expect(rulesOf(file).length, `${file} parsed no rules`).toBeGreaterThan(0);
		}
		// Canary: a selector that exists in the sheet and must parse as a rule
		// with its declarations. Without it a parser regression would make every
		// assertion above fail for the wrong reason — or worse, pass vacuously.
		const canary = rulesOf("apps/desktop/src/styles/gui-settings.css").find(rule =>
			declares(rule, ".gui-model-list"),
		);
		expect(canary?.declarations.get("overflow-y")).toBe("auto");
	});

	test("no later rule re-opens the chain for a floating surface", () => {
		for (const surface of SURFACES) {
			for (const file of new Set(SURFACES.map(surface => surface.file))) {
				const reopened = rulesOf(file)
					.filter(rule => declares(rule, surface.selector))
					.map(rule => rule.declarations.get("overscroll-behavior"))
					.filter((value): value is string => value !== undefined && value !== "contain");
				expect(reopened, `${surface.selector} is re-opened in ${file}: ${reopened.join(", ")}`).toEqual([]);
			}
		}
	});

	test("page-level scrollers keep chaining", () => {
		// Every sheet is scanned, not just the one that defines the selector: a
		// later sheet adding containment would trap the wheel just as well.
		const sheets = new Set(SURFACES.map(surface => surface.file));
		for (const file of PAGE_SCROLLERS.map(page => page.file)) sheets.add(file);
		for (const page of PAGE_SCROLLERS) {
			for (const file of sheets) {
				const declared = rulesOf(file)
					.filter(rule => declares(rule, page.selector))
					.map(rule => rule.declarations.get("overscroll-behavior"))
					.filter((value): value is string => value !== undefined);
				expect(declared, `${page.selector} must not contain in ${file}: it is a page-level scroller`).toEqual([]);
			}
		}
	});
});
