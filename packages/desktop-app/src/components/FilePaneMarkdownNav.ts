/**
 * A Markdown file preview's local navigation.
 *
 * The shared `Markdown` component resolves relative image sources against the
 * session cwd and routes http(s) links to the in-app browser — both fine for a
 * transcript. A markdown FILE preview needs two more behaviors, and neither
 * belongs in the shared component: a relative link should open the target file
 * in this pane (the file lives in the same workspace), and a `#fragment` link
 * should scroll to the heading in this preview rather than open a new window
 * (the renderer marks every link `target=_blank`, so the fragment would open
 * the whole app there instead).
 *
 * The images are already handled by the shared component's
 * `resolveLocalImages`; this hook covers what that cannot know about.
 */
import { useEffect } from "react";

/** GitHub-style heading slug, which is what `#some-heading` links are written against. */
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

/**
 * Whether the href is a relative reference the page itself cannot resolve —
 * not a URL, not an anchor, not protocol-relative.
 */
function isRelativeReference(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
	return !/^[a-z][a-z\d+.-]*:/i.test(trimmed);
}

/**
 * Wires the preview container's clicks.
 *
 * @param container the rendered preview element, or null while unmounted —
 *   state rather than a ref, so mounting re-runs the wiring.
 * @param previewPath the previewed file's workspace-relative path; relative
 *   links resolve against its directory.
 * @param onOpenFile opens the resolved target as this pane's new preview.
 */
export function useMarkdownFileNavigation(
	container: HTMLElement | null,
	previewPath: string | null,
	onOpenFile: (workspacePath: string) => void,
): void {
	useEffect(() => {
		if (!container || !previewPath) return;

		const baseDirectory = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);
		const resolve = (reference: string): string => {
			const clean = decodeReference(reference.split(/[?#]/, 1)[0] ?? "");
			if (clean.startsWith("/")) return clean.slice(1);
			return baseDirectory + clean;
		};

		// Scrolls to the heading a `#fragment` link points at; false when there
		// is none — the headings carry no ids, so the match is by slug text.
		const scrollToHeading = (fragment: string): boolean => {
			const wanted = decodeReference(fragment.replace(/^#/, "")).toLowerCase();
			if (!wanted) return false;
			for (const heading of Array.from(container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
				if (headingSlug(heading.textContent ?? "") === wanted) {
					heading.scrollIntoView({ block: "start" });
					return true;
				}
			}
			return false;
		};

		const handleClick = (event: MouseEvent): void => {
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
			// The renderer marks every link `target=_blank`; a fragment would
			// open the whole app in a new window instead of moving within this
			// file, and a relative link would resolve against the app's own URL.
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
			onOpenFile(resolve(href));
		};

		container.addEventListener("click", handleClick, true);
		return () => container.removeEventListener("click", handleClick, true);
	}, [container, previewPath, onOpenFile]);
}
