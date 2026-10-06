/**
 * UsageDashboard - fullscreen alternate-screen view of provider usage.
 *
 * Chrome mirrors the `/agents` and `/extensions` overlays: a titled box on the
 * alternate screen with a scrollable body. Two views, matching the upstream
 * idiom: a compact per-account summary built here, and the full classic report
 * (the very renderer the inline `/usage` panel uses) as the expanded view, so
 * the two surfaces can never disagree about what a provider's usage is.
 *
 * Navigation:
 * - Enter or d: toggle summary / details
 * - Wheel / PageUp / PageDown / Home / End: scroll
 * - Esc: close
 */
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@musepi/pi-ai";
import {
	type Component,
	matchesKey,
	padding,
	parseSgrMouse,
	ScrollView,
	TooltipHint,
	truncateToWidth,
	visibleWidth,
} from "@musepi/pi-tui";
import { formatDuration, formatNumber } from "@musepi/pi-utils";
import { t } from "../../i18n/index.js";
import {
	formatAbsoluteOnlyAmount,
	formatRemainingOnlyTotal,
	isRemainingOnlyAbsoluteAmount,
} from "../../utils/usage-amounts";
import { formatLimitTitle, usageAccountLabel } from "../../utils/usage-display";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { bottomBorder, row, topBorder } from "./overlay-box";

export interface UsageDashboardOptions {
	reports: UsageReport[];
	/** The inline panel's renderer, reused verbatim as the expanded view. */
	renderDetail: (width: number, reports: UsageReport[]) => string;
	onClose?: () => void;
	onRequestRender?: () => void;
}

type View = "summary" | "detail";

/** Top border + body + blank + hint + bottom border. */
const CHROME_ROWS = 4;
const MIN_BODY_ROWS = 3;
const DEFAULT_VIEWPORT_ROWS = 24;
const ACCOUNT_INDENT = "  ";
const LIMIT_INDENT = "    ";
/** `row()` insets by a border column and a space on each side. */
const BOX_INSET = 2;
/** Screen row of the first body row: the top border occupies row 0. */
const BODY_TOP_ROW = 1;

function usageValue(limit: UsageLimit): string {
	const fraction = resolveUsedFraction(limit);
	if (fraction !== undefined) {
		return t("{0}% free").replace("{0}", formatNumber(Math.max(0, (1 - fraction) * 100)));
	}
	return formatAbsoluteOnlyAmount([limit]) ?? t("no data");
}

function usageReset(limit: UsageLimit, nowMs: number): string {
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt === undefined || resetsAt <= nowMs) return "";
	return t("resets in {0}").replace("{0}", formatDuration(resetsAt - nowMs));
}

export class UsageDashboard implements Component {
	readonly #reports: UsageReport[];
	readonly #renderDetail: UsageDashboardOptions["renderDetail"];
	readonly #nowMs: number;
	readonly #viewport: ScrollView;
	readonly #hints = new TooltipHint();
	#view: View = "summary";
	#viewportRows = DEFAULT_VIEWPORT_ROWS;
	/** `view:width` of the content currently loaded into the viewport. */
	#contentKey = "";
	/** Text the hovered cell truncated away, or undefined when nothing is hovered. */
	#hoverText: string | undefined;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(options: UsageDashboardOptions) {
		this.#reports = options.reports;
		this.#renderDetail = options.renderDetail;
		this.onClose = options.onClose;
		this.onRequestRender = options.onRequestRender;
		this.#nowMs = Date.now();
		this.#viewport = new ScrollView([], { height: this.#bodyRows(), scrollbar: "auto" });
	}

	#bodyRows(): number {
		return Math.max(MIN_BODY_ROWS, this.#viewportRows - CHROME_ROWS);
	}

	setViewportRowsProvider(provider: () => number): void {
		const rows = provider();
		if (rows === this.#viewportRows) return;
		this.#viewportRows = rows;
		this.#viewport.setHeight(this.#bodyRows());
	}

	/**
	 * One line per account, one per limit: the quota tables in this app are
	 * short enough that a second column layout buys nothing over padding the
	 * title and letting the value sit in a fixed column.
	 */
	#summaryLines(width: number): string[] {
		const lines: string[] = [];
		// The value and reset columns are fixed so rows stay readable; the title
		// takes whatever is left and is truncated with a leading ellipsis.
		const valueWidth = 16;
		const resetWidth = 18;
		const anyReset = this.#reports.some(report => report.limits.some(limit => usageReset(limit, this.#nowMs) !== ""));
		const titleWidth = Math.max(8, width - valueWidth - (anyReset ? resetWidth + 2 : 0) - 2);
		this.#hints.clear();

		for (const report of this.#reports) {
			lines.push("", theme.bold(theme.fg("accent", report.provider)));
			const account = usageAccountLabel(report, report.limits[0], 0);
			this.#trackCell(lines.length, BOX_INSET, width - BOX_INSET * 2, account);
			lines.push(`${ACCOUNT_INDENT}${account}`);
			for (const limit of report.limits) {
				const fullTitle = formatLimitTitle(limit);
				const fullReset = usageReset(limit, this.#nowMs);
				// Title and reset sit in their own columns, so each is hinted where
				// it is painted rather than the row as a whole.
				this.#trackCell(lines.length, LIMIT_INDENT.length, titleWidth, fullTitle);
				if (fullReset !== "") {
					this.#trackCell(
						lines.length,
						LIMIT_INDENT.length + titleWidth + 2 + valueWidth + 2,
						resetWidth,
						fullReset,
					);
				}
				const title = truncateToWidth(fullTitle, titleWidth);
				const value = truncateToWidth(usageValue(limit), valueWidth);
				const head = `${LIMIT_INDENT}${title}${padding(Math.max(0, titleWidth - title.length))}  ${value}`;
				lines.push(fullReset === "" ? head : `${head}  ${theme.fg("dim", truncateToWidth(fullReset, resetWidth))}`);
			}
			// The pool total is only meaningful across the remaining-only meters:
			// a provider that also reports percentage windows would otherwise
			// have its balance dropped for mixing buckets. Each such row already
			// shows its own amount, so the line is the sum the rows cannot give.
			const balanceMeters = report.limits.filter(limit => isRemainingOnlyAbsoluteAmount(limit));
			const prepaid = formatRemainingOnlyTotal(balanceMeters);
			if (prepaid !== undefined && balanceMeters.length > 1) {
				const label = t("prepaid: {0}").replace("{0}", prepaid);
				this.#trackCell(lines.length, LIMIT_INDENT.length, width - BOX_INSET * 2, label);
				lines.push(`${LIMIT_INDENT}${theme.fg("dim", label)}`);
			}
		}
		return lines;
	}

	/**
	 * Record what a cell truncated away, in screen coordinates: the box's top
	 * border takes row 0 and `ScrollView` paints the body from the current scroll
	 * offset, so a content row maps to `BODY_TOP_ROW + row - offset`. A cell that
	 * fits records nothing, so hovering never raises an unasked-for hint.
	 */
	#trackCell(contentRow: number, from: number, available: number, fullText: string): void {
		const hidden = visibleWidth(fullText) > available ? fullText : "";
		this.#hints.track(
			BODY_TOP_ROW + contentRow - this.#viewport.getScrollOffset(),
			BOX_INSET + from,
			available,
			hidden,
		);
	}

	/**
	 * Re-render the body only when its inputs changed — the view toggle and the
	 * inner render width. A height change alone just moves the window over the
	 * same lines, so it must not reset the scroll offset.
	 *
	 * The renderer is given the *inner* width, the same one the viewport will
	 * paint into: laying out against the outer width would leave every report
	 * truncated by the box's own insets.
	 */
	#refresh(innerWidth: number): void {
		const key = `${this.#view}:${innerWidth}`;
		if (key === this.#contentKey) return;
		this.#contentKey = key;
		this.#hints.clear();
		this.#viewport.setLines(
			(this.#view === "detail"
				? this.#renderDetail(innerWidth, this.#reports)
				: this.#summaryLines(innerWidth).join("\n")
			).split("\n"),
		);
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(0, width - BOX_INSET * 2);
		this.#refresh(innerWidth);
		const body = this.#viewport.render(innerWidth).map(line => row(line, width));
		const title = this.#view === "detail" ? t("Usage · Details") : t("Usage");
		// A hovered cell's full text replaces the key hint: the hint bar is the one
		// row the reader is looking at anyway, and a second line would shrink the
		// body on exactly the frames where the text is worth reading.
		const footer =
			this.#hoverText === undefined
				? this.#view === "detail"
					? t("Enter summary · Esc close")
					: this.#viewport.getMaxScrollOffset() > 0
						? t("Enter details · wheel scrolls · Esc close")
						: t("Enter details · Esc close")
				: this.#hoverText;
		return [topBorder(width, title), ...body, "", row(footer, width), bottomBorder(width)];
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event === null) return;
			if (event.wheel !== null) {
				this.#viewport.scroll(event.wheel);
				this.onRequestRender?.();
				return;
			}
			if (event.motion) {
				// The body scrolls under a stationary pointer, so a hint is only
				// trustworthy while the rows under the pointer are the ones painted:
				// hovering after a scroll asks about whatever moved into that row.
				this.#hoverText = this.#hints.hover(event.col, event.row);
				this.onRequestRender?.();
			}
			return;
		}

		if (matchesKey(data, "ctrl+c") || matchesAppInterrupt(data)) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, "enter") || matchesKey(data, "tab") || data === "d") {
			this.#view = this.#view === "summary" ? "detail" : "summary";
			this.#viewport.scrollToTop();
			this.onRequestRender?.();
			return;
		}

		if (this.#viewport.handleScrollKey(data)) this.onRequestRender?.();
	}
}
