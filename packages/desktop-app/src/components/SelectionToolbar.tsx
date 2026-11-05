import { t } from "@musepi/client-core";
import { captureQuoteAnchor, findQuoteRoot } from "@musepi/client-core/src/components/transcript/quote-anchor";
import type { ChatQuoteAnchor, OfficeQuoteAnchor, PdfQuoteAnchor } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tapFeedback } from "../lib/haptic";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon, type IconName } from "../vendor/oc-icons";
import { MENU_ANIM_MS } from "./MenuPopup";

/** Message a DOM selection came from, so the quote can be anchored back to it. */
export interface SelectionQuoteSource {
	messageId?: string;
	anchor?: ChatQuoteAnchor;
}

const SELECTION_SKIP_SELECTOR =
	".tr-code-head, .tr-table-bar, .tr-table-menu, .katex-mathml, button, input, script, style";

const SELECTION_BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DETAILS",
	"DIV",
	"DL",
	"FIGURE",
	"FOOTER",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"SUMMARY",
	"TABLE",
	"UL",
]);

/** Blocks that hold one piece of text: a selection inside one of them is that
 *  text, not the list, table or emphasis around it. */
const SELECTION_TEXT_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, td, th, summary, dt, dd";

const isElementNode = (node: Node | null): node is Element => node?.nodeType === 1;

function longestRun(text: string, char: string): number {
	let longest = 0;
	let run = 0;
	for (const value of text) {
		run = value === char ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

function fencedCode(code: string, language: string): string {
	const marker = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
	const body = code.endsWith("\n") ? code : `${code}\n`;
	return `${marker}${language}\n${body}${marker}`;
}

function inlineCode(text: string): string {
	const marker = "`".repeat(longestRun(text, "`") + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${marker}${pad}${text}${pad}${marker}`;
}

// Emphasis markers must hug the text: `** bold **` is not bold.
function wrapInline(text: string, marker: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
	if (!match?.[2]) return text;
	return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function selectionCodeLanguage(element: Element): string {
	const code = element.querySelector("pre code") ?? element.querySelector("code");
	const fromClass = code?.className.match(/language-([\w+#.-]+)/)?.[1];
	if (fromClass) return fromClass === "text" ? "" : fromClass;
	const label = element.querySelector(".tr-code-lang")?.textContent?.trim() ?? "";
	return label === "text" ? "" : label;
}

function selectionCodeText(element: Element): string {
	// `.tr-code` also holds its language label and copy button; the source is
	// the `<code>` body only. Highlighting replaces the body's spans but keeps
	// the raw source in its text.
	const code = element.querySelector("pre code") ?? element.querySelector("code") ?? element;
	return (code.textContent ?? "").replace(/\n$/, "");
}

function escapeTableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function serializeSelectionTable(table: Element): string {
	const rows = Array.from(table.querySelectorAll("tr"))
		.map(row =>
			Array.from(row.children)
				.filter(cell => cell.tagName === "TH" || cell.tagName === "TD")
				.map(cell => escapeTableCell(serializeSelectionInline(cell))),
		)
		.filter(cells => cells.length > 0);
	if (rows.length === 0) return "";
	const width = Math.max(...rows.map(cells => cells.length));
	const line = (cells: string[]): string =>
		`| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
	const [head, ...body] = rows;
	const firstRowCells = table.querySelector("tr")?.children;
	const alignment = Array.from({ length: width }, (_, index) => {
		const cell = firstRowCells?.[index];
		const align =
			cell?.getAttribute("align") ?? cell?.getAttribute("style")?.match(/text-align:\s*(left|right|center)/)?.[1];
		return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
	});
	return [line(head ?? []), `| ${alignment.join(" | ")} |`, ...body.map(line)].join("\n");
}

function prefixLines(text: string, first: string, rest: string): string {
	return text
		.split("\n")
		.map((line, index) => (index === 0 ? first : line ? rest : "") + line)
		.join("\n");
}

function serializeSelectionList(list: Element): string {
	const ordered = list.tagName === "OL";
	let number = Number.parseInt(list.getAttribute("start") ?? "1", 10);
	if (!Number.isFinite(number)) number = 1;
	const items: string[] = [];
	for (const child of Array.from(list.children)) {
		if (child.tagName !== "LI") continue;
		const marker = ordered ? `${number}. ` : "- ";
		number += 1;
		const checkbox = Array.from(child.children)
			.flatMap(element => (element.tagName === "P" ? Array.from(element.children) : [element]))
			.find(element => element.matches('input[type="checkbox"]'));
		const task = checkbox ? (checkbox.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
		items.push(prefixLines(`${task}${serializeSelectionBlocks(child)}`, marker, " ".repeat(marker.length)));
	}
	return items.join("\n");
}

function isSelectionBlock(element: Element): boolean {
	if (element.matches(".tr-code, .tr-table")) return true;
	return SELECTION_BLOCK_TAGS.has(element.tagName);
}

function serializeSelectionBlock(element: Element): string {
	if (element.matches(".tr-code") || element.tagName === "PRE") {
		return fencedCode(selectionCodeText(element), selectionCodeLanguage(element));
	}
	if (element.matches(".tr-table") || element.tagName === "TABLE") {
		const table = element.tagName === "TABLE" ? element : element.querySelector("table");
		return table ? serializeSelectionTable(table) : "";
	}
	switch (element.tagName) {
		case "H1":
		case "H2":
		case "H3":
		case "H4":
		case "H5":
		case "H6": {
			const text = serializeSelectionInline(element).trim();
			return `${"#".repeat(Number(element.tagName[1]))} ${text}`;
		}
		case "HR":
			return "---";
		case "UL":
		case "OL":
			return serializeSelectionList(element);
		case "LI":
			// A list item without its list: the selection started inside it.
			return prefixLines(serializeSelectionBlocks(element), "- ", "  ");
		case "BLOCKQUOTE": {
			const text = serializeSelectionBlocks(element);
			return text
				.split("\n")
				.map(line => (line ? `> ${line}` : ">"))
				.join("\n");
		}
		default:
			return serializeSelectionBlocks(element);
	}
}

function serializeSelectionInline(element: Element): string {
	const content = (): string => serializeSelectionInlineNodes(element);
	switch (element.tagName) {
		case "STRONG":
		case "B":
			return wrapInline(content(), "**");
		case "EM":
		case "I":
			return wrapInline(content(), "*");
		case "DEL":
		case "S":
		case "STRIKE":
			return wrapInline(content(), "~~");
		case "CODE":
			return inlineCode(element.textContent ?? "");
		case "BR":
			return "\n";
		case "IMG": {
			const alt = element.getAttribute("alt") ?? "";
			const src = element.getAttribute("src") ?? "";
			return src ? `![${alt}](${src})` : alt;
		}
		case "A": {
			const text = content();
			const href = element.getAttribute("href") ?? "";
			if (!href || text.trim() === href) return text;
			return `[${text}](${href})`;
		}
		default:
			return content();
	}
}

function serializeSelectionNode(node: Node): { block: boolean; text: string } | null {
	if (node.nodeType === 3) return { block: false, text: (node.textContent ?? "").replace(/\u2060/g, "") };
	if (!isElementNode(node) || node.matches(SELECTION_SKIP_SELECTOR)) return null;
	if (isSelectionBlock(node)) return { block: true, text: serializeSelectionBlock(node) };
	return { block: false, text: serializeSelectionInline(node) };
}

function serializeSelectionNodes(nodes: readonly Node[], blockSeparator: string): string {
	const blocks: string[] = [];
	let inline = "";
	const flush = (): void => {
		const text = inline.trim();
		if (text) blocks.push(text);
		inline = "";
	};
	for (const node of nodes) {
		const serialized = serializeSelectionNode(node);
		if (!serialized) continue;
		if (!serialized.block) {
			inline += serialized.text;
			continue;
		}
		flush();
		if (serialized.text.trim()) blocks.push(serialized.text);
	}
	flush();
	return blocks.join(blockSeparator);
}

function serializeSelectionBlocks(element: Element): string {
	return serializeSelectionNodes(Array.from(element.childNodes), "\n\n");
}

function serializeSelectionInlineNodes(element: Element): string {
	return Array.from(element.childNodes)
		.map(node => serializeSelectionNode(node)?.text ?? "")
		.join("");
}

/**
 * Rebuild the selected DOM with the ancestors `cloneContents` drops at the two
 * range boundaries, stopping at the markdown body (and at a code card, so the
 * unselected language label and copy chrome cannot enter the quote). A
 * selection inside one text block is not re-nested.
 */
function wrapSelection(range: Range, markdownRoot: Element): HTMLElement {
	const fragment = range.cloneContents();
	let content: Node = fragment;
	let ancestor: Node | null = range.commonAncestorContainer;
	if (ancestor.nodeType === 3) ancestor = ancestor.parentNode;
	const codeCard = isElementNode(ancestor) ? ancestor.closest(".tr-code") : null;
	const textBlock = isElementNode(ancestor) ? ancestor.closest(SELECTION_TEXT_BLOCK_SELECTOR) : null;
	if (!codeCard && textBlock && textBlock !== markdownRoot) ancestor = null;
	while (ancestor && ancestor !== markdownRoot && ancestor.nodeType === 1) {
		const shell = (ancestor as Element).cloneNode(false) as Element;
		shell.appendChild(content);
		content = shell;
		if (ancestor === codeCard) break;
		ancestor = ancestor.parentNode;
	}
	const holder = markdownRoot.ownerDocument.createElement("div");
	holder.appendChild(content);
	return holder;
}

/**
 * The selected part of rendered transcript markdown, restored to Markdown so a
 * quoted code block keeps its fence and language, a table keeps its rows, and
 * formatting the reader sees does not flatten into plain text. Selections
 * outside rendered markdown (file previews, editors, PDF text) and malformed
 * ranges fall back to their plain text.
 */
export function rangeToMarkdown(range: Range, root?: Element | null): string {
	const plain = typeof range.toString === "function" ? range.toString().replace(/\r\n?/g, "\n") : "";
	try {
		const startNode = range.startContainer as Node | undefined;
		const startElement =
			startNode?.nodeType === 1 ? (startNode as Element) : (startNode?.parentNode as Element | null);
		const markdownRoot = startElement?.closest?.(".tr-md") ?? null;
		if (!markdownRoot || (root && !root.contains(markdownRoot))) return plain;
		const markdown = serializeSelectionNodes(
			Array.from(wrapSelection(range, markdownRoot).childNodes),
			"\n\n",
		).trim();
		return markdown || plain;
	} catch {
		return plain;
	}
}

/**
 * Message and anchor of a transcript DOM selection, or undefined when the
 * selection is not inside a message row (file previews, editors) or its text
 * cannot be located again. Without a resolvable anchor the quote keeps the
 * pre-anchor behavior: no source jump, no highlight.
 */
function selectionQuoteSource(host: HTMLElement, range: Range): SelectionQuoteSource | undefined {
	try {
		const startNode = range.startContainer as Node | undefined;
		const startElement =
			startNode?.nodeType === 1 ? (startNode as Element) : (startNode?.parentNode as Element | null);
		const messageId = startElement?.closest?.("[data-entry-id]")?.getAttribute("data-entry-id");
		if (!messageId) return undefined;
		const root = findQuoteRoot(host, messageId);
		const anchor = root ? captureQuoteAnchor(root, range) : null;
		return anchor ? { messageId, anchor } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Floating actions for in-message text selection:
 * selecting text inside the transcript pops a small glass toolbar above
 * the selection with 引用 (quote to composer) / 评论 / 复制 / 基于选择新建会话 /
 * 添加到笔记. 评论 expands a compact editor beside the toolbar and submits the
 * quote together with the typed comment. Dismisses on outside click, scroll,
 * or Escape.
 *
 * PORTALLED to the React root, and that is load-bearing, not stylistic.
 * `.gui-select-pop` is `position: fixed` and this component mounts inside
 * `.gui-transcript-wrap`, which declares `container-type: size`. Layout
 * containment makes that wrap the CONTAINING BLOCK for fixed descendants, so
 * the viewport coordinates reported by `range.getBoundingClientRect()` were
 * resolved against the wrap instead of the window — the toolbar landed
 * offset by the wrap's origin and was clipped by the chat column's
 * `overflow: hidden` (audit 2026-10-18). Portalling restores the viewport as
 * the containing block, which is what the coordinates mean.
 */
export function SelectionToolbar({
	containerRef,
	selection,
	avoidSelector,
	onQuote,
	onAsk,
	onCopy,
	onNewSession,
	onAddNote,
}: {
	/** The transcript scroll container — selections outside it are ignored. */
	containerRef: React.RefObject<HTMLElement | null>;
	/** Optional editor-owned selection. When supplied, DOM selection capture is
	 * disabled because Monaco does not expose its selection through window. */
	selection?: {
		text: string;
		x: number;
		y: number;
		height: number;
		pdf?: PdfQuoteAnchor;
		office?: OfficeQuoteAnchor;
	} | null;
	/** Visible editor floating UI that this toolbar must not cover. */
	avoidSelector?: string;
	onQuote(
		text: string,
		pdf?: PdfQuoteAnchor,
		office?: OfficeQuoteAnchor,
		comment?: string,
		source?: SelectionQuoteSource,
	): void;
	/** Open the selection→ask popover for this selection (throws away the
	 * answer — never recorded to the transcript). */
	onAsk(text: string, x: number, y: number): void;
	onCopy(text: string): void;
	onNewSession(text: string): void;
	onAddNote(text: string): void;
}): ReactNode {
	const [pop, setPop] = useState<{
		x: number;
		y: number;
		height: number;
		text: string;
		pdf?: PdfQuoteAnchor;
		office?: OfficeQuoteAnchor;
		source?: SelectionQuoteSource;
	} | null>(null);
	// Exit: keep the toolbar mounted through gui-select-pop-out before
	// unmounting (Pop parity); the frosted chip also needs the two-phase
	// enter so its backdrop composites before the fade-in plays.
	const [closing, setClosing] = useState(false);
	const enteredCls = useTwoPhaseEnter(pop !== null);
	// Inline comment editor. It edits the comment for the CURRENT quote only,
	// so a new selection (or dismissal) discards the draft.
	const [commentOpen, setCommentOpen] = useState(false);
	const [commentText, setCommentText] = useState("");
	const commentInputRef = useRef<HTMLInputElement | null>(null);
	const commentOpenRef = useRef(commentOpen);
	commentOpenRef.current = commentOpen;
	useEffect(() => {
		setCommentOpen(false);
		setCommentText("");
	}, [pop?.text, pop?.x, pop?.y, pop?.height]);
	useEffect(() => {
		if (commentOpen) commentInputRef.current?.focus();
	}, [commentOpen]);
	// dismiss is bound once inside the effect — read state through refs so
	// it always sees the latest pop/closing.
	const popRef = useRef(pop);
	popRef.current = pop;
	const closingRef = useRef(closing);
	closingRef.current = closing;
	const hideTimer = useRef(0);
	// Stable identity (only refs in deps) so the effect below binds the
	// listeners once; it reads fresh pop/closing through the refs.
	const dismiss = useCallback((): void => {
		if (!popRef.current || closingRef.current) return;
		setClosing(true);
		window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			setPop(null);
			setClosing(false);
		}, MENU_ANIM_MS);
	}, []);
	// Group expansion: hovering ANY button expands ALL of them at once, so
	// the icons stop drifting while the cursor travels between buttons
	// (per-button expand shoved its neighbours mid-move and made them
	// hard to hit).
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		if (selection === undefined) return;
		window.clearTimeout(hideTimer.current);
		if (!selection) {
			dismiss();
			return;
		}
		setClosing(false);
		setPop({
			text: selection.text,
			x: selection.x,
			y: selection.y,
			height: selection.height,
			...(selection.pdf ? { pdf: selection.pdf } : {}),
			...(selection.office ? { office: selection.office } : {}),
		});
	}, [selection, dismiss]);

	useEffect(() => {
		// The pane container is created after this component mounts (FilePane
		// keys tabs and starts with no preview), so resolve it per event instead
		// of bailing out once and never binding the listeners.
		const onMouseUp = (event: MouseEvent): void => {
			const el = containerRef.current;
			if (!el) return;
			// Ignore releases outside the pane (other tab, toolbar, composer).
			if (!(event.target instanceof Node) || !el.contains(event.target)) return;
			// Let the browser settle the selection (click-drag releases
			// before the range is final).
			window.clearTimeout(hideTimer.current);
			hideTimer.current = window.setTimeout(() => {
				const host = containerRef.current;
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed) {
					dismiss();
					return;
				}
				if (!host || !sel.anchorNode || !host.contains(sel.anchorNode)) {
					dismiss();
					return;
				}
				const range = sel.getRangeAt(0);
				// The prompt keeps the Markdown the reader selected (fences,
				// tables, emphasis); plain text is the fallback outside rendered
				// markdown and for synthetic ranges.
				const text = (rangeToMarkdown(range, host) || sel.toString()).trim();
				if (!text) {
					dismiss();
					return;
				}
				const source = selectionQuoteSource(host, range);
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					dismiss();
					return;
				}
				// Kimi Code anchors the chip at the end of the gesture, not at
				// the top of the whole selection: a long multi-line selection
				// would otherwise park the toolbar far above the pointer. Use
				// the release point, falling back to the last line rect for
				// keyboard selections and synthetic relays.
				const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
				const endRect = rects[rects.length - 1] ?? rect;
				const endX = endRect.right || endRect.left + endRect.width;
				const hasPointer =
					Number.isFinite(event.clientX) &&
					Number.isFinite(event.clientY) &&
					(event.clientX !== 0 || event.clientY !== 0);
				// A fresh selection while the old toolbar is fading out:
				// cancel the pending unmount and re-show at the new spot.
				window.clearTimeout(hideTimer.current);
				setClosing(false);
				setPop({
					x: hasPointer ? Math.round(event.clientX) : Math.round(endX),
					y: hasPointer ? Math.round(event.clientY) : Math.round(endRect.top),
					height: Math.round(hasPointer ? Math.max(16, endRect.height) : endRect.height),
					text,
					...(source ? { source } : {}),
				});
			}, 10);
		};
		const onDown = (e: MouseEvent): void => {
			// A click outside the toolbar itself dismisses it. While the
			// comment editor is open the click only discards the draft: the
			// toolbar (and its captured quote) stays up.
			const target = e.target as HTMLElement | null;
			if (target?.closest(".gui-select-pop") || target?.closest(".gui-select-pop-comment")) return;
			if (commentOpenRef.current) {
				setCommentOpen(false);
				setCommentText("");
				return;
			}
			dismiss();
		};
		const onScroll = (event: Event): void => {
			const el = containerRef.current;
			if (!el || !(event.target instanceof Node) || !el.contains(event.target)) return;
			dismiss();
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			// Capture phase + preventDefault: this transient toolbar owns
			// Escape while it is up. Focus sits on the selection (outside the
			// toolbar), and the window-level bare-Escape binding interrupts
			// the running turn for unclaimed Escape — dismissing a selection
			// must not abort a turn.
			e.preventDefault();
			if (commentOpenRef.current) {
				setCommentOpen(false);
				setCommentText("");
				return;
			}
			dismiss();
		};
		if (selection === undefined) document.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onDown);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.clearTimeout(hideTimer.current);
			document.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onDown);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [containerRef, dismiss, selection === undefined]);

	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const [horizontalShift, setHorizontalShift] = useState(0);
	useLayoutEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar || !pop) return;
		setHorizontalShift(0);
		let frame: number | null = null;
		const clamp = (): void => {
			frame = null;
			const rect = toolbar.getBoundingClientRect();
			const delta =
				rect.left < 8 ? 8 - rect.left : rect.right > window.innerWidth - 8 ? window.innerWidth - 8 - rect.right : 0;
			if (Math.abs(delta) > 0.5) setHorizontalShift(current => current + delta);
		};
		const schedule = (): void => {
			if (frame !== null) return;
			frame = requestAnimationFrame(clamp);
		};
		const resize = new ResizeObserver(schedule);
		resize.observe(toolbar);
		window.addEventListener("resize", schedule);
		clamp();
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			resize.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, [pop]);

	if (!pop) return null;
	const aboveTop = pop.y - 38;
	const belowTop = pop.y + pop.height + 4;
	const container = containerRef.current;
	const containerTop = container?.getBoundingClientRect().top ?? 0;
	let top = aboveTop < containerTop ? belowTop : aboveTop;
	if (container && avoidSelector) {
		// Collapsed geometry: six 26px buttons, five 2px gaps, padding and border.
		const width = 176;
		const height = 36;
		const overlaps = (candidateTop: number): boolean =>
			Array.from(container.querySelectorAll<HTMLElement>(avoidSelector)).some(element => {
				const obstacle = element.getBoundingClientRect();
				return (
					obstacle.width > 0 &&
					obstacle.height > 0 &&
					pop.x - width / 2 < obstacle.right &&
					pop.x + width / 2 > obstacle.left &&
					candidateTop < obstacle.bottom &&
					candidateTop + height > obstacle.top
				);
			});
		if (overlaps(top)) {
			const alternate = top === aboveTop ? belowTop : aboveTop;
			if (alternate >= containerTop) top = alternate;
		}
	}
	const closeComment = (): void => {
		setCommentOpen(false);
		setCommentText("");
	};
	const submitComment = (): void => {
		const comment = commentText.trim();
		if (!comment) return;
		tapFeedback();
		onQuote(pop.text, pop.pdf, pop.office, comment, pop.source);
		closeComment();
		dismiss();
	};
	const actions: Array<{ icon: IconName; label: string; run(): void; keepOpen?: boolean }> = [
		{
			icon: "chat-1",
			label: t("settings.quoteChat"),
			run: () => onQuote(pop.text, pop.pdf, pop.office, undefined, pop.source),
		},
		{
			icon: "chat-3",
			label: t("annotation.commentLabel"),
			keepOpen: true,
			run: () => {
				if (commentOpen) closeComment();
				else setCommentOpen(true);
			},
		},
		{ icon: "sparkling", label: t("settings.askAboutSelection"), run: () => onAsk(pop.text, pop.x, pop.y) },
		{ icon: "file-copy-2", label: t("settings.copy"), run: () => onCopy(pop.text) },
		{ icon: "chat-new", label: t("settings.newSessionSelection"), run: () => onNewSession(pop.text) },
		{ icon: "sticky-note", label: t("settings.addNotes"), run: () => onAddNote(pop.text) },
	];
	const commentPanelWidth = Math.min(320, window.innerWidth - 16);
	const commentPanelLeft = Math.min(
		Math.max(pop.x + horizontalShift, 8 + commentPanelWidth / 2),
		window.innerWidth - 8 - commentPanelWidth / 2,
	);
	// Below the toolbar when there is no room above it in the viewport.
	const commentPanelBelow = top < 150;
	// Portal into the React root (NOT document.body): React's delegated
	// listeners live on the root container, so a body-level portal never
	// bubbles through it and the buttons' clicks would silently die.
	return createPortal(
		<>
			<div
				ref={toolbarRef}
				className={`gui-select-pop${enteredCls ? " gui-select-pop--entered" : ""}${closing ? " gui-select-pop--closing" : ""}${expanded ? " gui-select-pop--expanded" : ""}`}
				role="toolbar"
				style={{
					left: pop.x + horizontalShift,
					top,
					transform: "translateX(-50%)",
				}}
				onMouseDown={e => e.preventDefault()} // keep the selection
				onMouseEnter={() => setExpanded(true)}
				onMouseLeave={() => setExpanded(false)}
			>
				{actions.map(a => (
					<button
						key={a.label}
						type="button"
						className="gui-select-pop-btn"
						title={a.label}
						aria-label={a.label}
						onClick={() => {
							tapFeedback();
							a.run();
							if (a.keepOpen) return;
							closeComment();
							dismiss();
						}}
					>
						<Icon name={a.icon} className="h-3.5 w-3.5" />
						<span className="gui-select-pop-label">{a.label}</span>
					</button>
				))}
			</div>
			{commentOpen ? (
				<div
					className="gui-select-pop-comment"
					role="dialog"
					aria-label={t("annotation.commentLabel")}
					style={{
						position: "fixed",
						zIndex: 61,
						left: commentPanelLeft,
						top: commentPanelBelow ? top + 42 : top - 6,
						transform: commentPanelBelow ? "translateX(-50%)" : "translate(-50%, -100%)",
						width: commentPanelWidth,
						display: "flex",
						flexDirection: "column",
						gap: 8,
						padding: "8px 10px",
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-xl)",
						background: "var(--color-surface-raised)",
						boxShadow: "0 10px 32px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.04)",
						backdropFilter: "blur(var(--gui-glass-blur)) saturate(var(--gui-glass-saturate))",
						pointerEvents: "auto",
					}}
				>
					<span
						title={pop.text}
						style={{
							overflow: "hidden",
							color: "var(--color-text-muted)",
							fontSize: "var(--ui-font-size-xs)",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{pop.text.replace(/\s+/g, " ")}
					</span>
					<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<input
							ref={commentInputRef}
							className="gui-select-pop-comment-input"
							value={commentText}
							placeholder={t("annotation.commentPlaceholder")}
							aria-label={t("annotation.commentLabel")}
							onChange={event => setCommentText(event.target.value)}
							onKeyDown={event => {
								if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
								event.preventDefault();
								event.stopPropagation();
								submitComment();
							}}
							style={{
								flex: 1,
								minWidth: 0,
								padding: "5px 8px",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-lg)",
								background: "var(--color-surface-sunken)",
								color: "var(--color-text)",
								fontSize: "var(--ui-font-size-sm)",
								outline: "none",
							}}
						/>
						<button
							type="button"
							onClick={closeComment}
							style={{
								padding: "4px 9px",
								border: 0,
								borderRadius: "var(--radius-lg)",
								background: "transparent",
								color: "var(--color-text-muted)",
								fontSize: "var(--ui-font-size-xs)",
								cursor: "pointer",
							}}
						>
							{t("settings.cancel")}
						</button>
						<button
							type="button"
							disabled={!commentText.trim()}
							onClick={submitComment}
							style={{
								padding: "4px 9px",
								border: 0,
								borderRadius: "var(--radius-lg)",
								background: "var(--color-accent-soft)",
								color: "var(--color-text)",
								fontSize: "var(--ui-font-size-xs)",
								cursor: commentText.trim() ? "pointer" : "default",
								opacity: commentText.trim() ? 1 : 0.5,
							}}
						>
							{t("settings.add")}
						</button>
					</div>
				</div>
			) : null}
		</>,
		document.getElementById("root") ?? document.body,
	);
}
