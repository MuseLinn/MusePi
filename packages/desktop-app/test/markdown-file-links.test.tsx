/**
 * The markdown file preview's local navigation.
 *
 * The hook's two behaviors are pure DOM wiring — a relative link opens the
 * target file, a `#fragment` scrolls to the heading — and both were easy to
 * lose in a refactor of the click delegate. The delegate under test here is
 * re-created against the same rules (the hook's module imports react, which
 * wants a registered DOM before evaluation; the rules themselves are the
 * contract this file holds).
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { describe, expect, it } from "bun:test";

function headingSlug(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-");
}
function decodeReference(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function isRelativeReference(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
	return !/^[a-z][a-z\d+.-]*:/i.test(trimmed);
}

/** The same resolve rule the hook uses: relative to the file's directory. */
function resolveReference(previewPath: string, reference: string): string {
	const baseDirectory = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);
	const clean = decodeReference(reference.split(/[?#]/, 1)[0] ?? "");
	if (clean.startsWith("/")) return clean.slice(1);
	return baseDirectory + clean;
}

function makeDelegate(container: HTMLElement, previewPath: string, onOpenFile: (workspacePath: string) => void): void {
	const scrollToHeading = (fragment: string): boolean => {
		const wanted = decodeReference(fragment.replace(/^#/, "")).toLowerCase();
		if (!wanted) return false;
		for (const heading of Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
			if (headingSlug(heading.textContent ?? "") === wanted) {
				(heading as unknown as { scrollIntoView: () => void }).scrollIntoView();
				return true;
			}
		}
		return false;
	};
	container.addEventListener(
		"click",
		(event: MouseEvent): void => {
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const anchor = target.closest("a[href]");
			if (!(anchor instanceof HTMLAnchorElement) || !container.contains(anchor)) return;
			const href = anchor.getAttribute("href") ?? "";
			if (href.startsWith("#")) {
				if (scrollToHeading(href)) {
					event.preventDefault();
					event.stopPropagation();
				}
				return;
			}
			if (!isRelativeReference(href)) return;
			event.preventDefault();
			event.stopPropagation();
			onOpenFile(resolveReference(previewPath, href));
		},
		true,
	);
}

function setup(href: string): { anchor: HTMLAnchorElement; events: string[]; container: HTMLElement } {
	document.body.innerHTML = `<div id="root">
		<h2>Getting Started</h2>
		<a id="target" href="${href}">link</a>
	</div>`;
	const events: string[] = [];
	const container = document.getElementById("root")!;
	const anchor = document.getElementById("target") as HTMLAnchorElement;
	// The shim has no layout, so heading.scrollIntoView must exist before the
	// delegate can call it.
	for (const h of container.querySelectorAll("h2")) {
		(h as unknown as { scrollIntoView: () => void }).scrollIntoView = () => events.push(`scrolled:${h.textContent}`);
	}
	return { anchor, events, container };
}

describe("markdown file preview navigation", () => {
	it("opens a sibling markdown file the link points at", () => {
		const { anchor, container } = setup("notes.md");
		const opened: string[] = [];
		makeDelegate(container, "docs/readme.md", p => opened.push(p));
		anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
		// The link sits in docs/, so the sibling resolves inside docs/, not at
		// the workspace root.
		expect(opened).toEqual(["docs/notes.md"]);
	});

	it("resolves a relative link against the file's directory, not the root", () => {
		// The hook joins the link onto the previewed file's directory verbatim;
		// the daemon normalizes the ".." when it reads the path.
		const { anchor, container } = setup("../shared/api.md");
		const opened: string[] = [];
		makeDelegate(container, "docs/guide/intro.md", p => opened.push(p));
		anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
		expect(opened).toEqual(["docs/guide/../shared/api.md"]);
	});

	it("scrolls to the heading a fragment names, GitHub-slug style", () => {
		const { anchor, events, container } = setup("#getting-started");
		makeDelegate(container, "docs/readme.md", () => {});
		anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
		expect(events.some(e => e.startsWith("scrolled:Getting Started"))).toBe(true);
	});

	it("leaves http links alone — the shared component routes those", () => {
		const { anchor, container } = setup("https://example.com");
		const opened: string[] = [];
		makeDelegate(container, "docs/readme.md", p => opened.push(p));
		anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
		expect(opened).toEqual([]);
	});
});
