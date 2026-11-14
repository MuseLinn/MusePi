import { t } from "@musepi/client-core";
import {
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	MoreHorizontal,
	PanelLeft,
	RotateCcw,
	RotateCw,
	Search,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";

type OverflowCommand = "fit-page" | "rotate-backward" | "rotate-forward" | "search" | "open-default";

export interface PdfToolbarProps {
	path: string;
	pageInput: string;
	currentPage: number;
	totalPages: number;
	currentZoom: number;
	thumbnails: boolean;
	searchOpen: boolean;
	onPageInput(value: string): void;
	onGoToPage(): void;
	onPreviousPage(): void;
	onNextPage(): void;
	onToggleThumbnails(): void;
	onZoomOut(): void;
	onZoomIn(): void;
	onFitWidth(): void;
	onFitPage(): void;
	onRotateBackward(): void;
	onRotateForward(): void;
	onToggleSearch(): void;
}

export default function PdfToolbar({
	path,
	pageInput,
	currentPage,
	totalPages,
	currentZoom,
	thumbnails,
	searchOpen,
	onPageInput,
	onGoToPage,
	onPreviousPage,
	onNextPage,
	onToggleThumbnails,
	onZoomOut,
	onZoomIn,
	onFitWidth,
	onFitPage,
	onRotateBackward,
	onRotateForward,
	onToggleSearch,
}: PdfToolbarProps): ReactNode {
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const moreRef = useRef<HTMLButtonElement | null>(null);
	const [overflow, setOverflow] = useState<OverflowCommand[]>([]);
	const [moreOpen, setMoreOpen] = useState(false);
	const moreMenu = useFloatingMenu(moreOpen, setMoreOpen, { align: "right" });

	useLayoutEffect(() => {
		const toolbar = toolbarRef.current;
		const more = moreRef.current;
		if (!toolbar || !more) return;
		let frame: number | null = null;
		const hasOverflow = (): boolean => {
			const bounds = toolbar.getBoundingClientRect();
			const contentRight = bounds.right - Number.parseFloat(getComputedStyle(toolbar).paddingRight);
			const visible = Array.from(toolbar.children).filter(
				(child): child is HTMLElement =>
					child instanceof HTMLElement && !child.hidden && !child.classList.contains("gui-pdf-toolbar-spacer"),
			);
			const last = visible.at(-1);
			return last ? last.getBoundingClientRect().right > contentRight + 1 : false;
		};
		const layout = (): void => {
			frame = null;
			const items = Array.from(toolbar.querySelectorAll<HTMLElement>("[data-pdf-overflow-item]"));
			for (const item of items) item.hidden = false;
			more.hidden = true;
			const next: OverflowCommand[] = [];
			if (hasOverflow()) {
				more.hidden = false;
				for (let index = items.length - 1; index >= 0 && hasOverflow(); index--) {
					const item = items[index];
					item.hidden = true;
					const command = item.dataset.pdfOverflowItem as OverflowCommand;
					next.unshift(command);
				}
			}
			setOverflow(current =>
				current.length === next.length && current.every((command, index) => command === next[index])
					? current
					: next,
			);
			if (next.length === 0) setMoreOpen(false);
		};
		const schedule = (): void => {
			if (frame !== null) return;
			frame = requestAnimationFrame(layout);
		};
		const resize = new ResizeObserver(schedule);
		resize.observe(toolbar);
		layout();
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			resize.disconnect();
		};
	}, []);

	const commands: Record<OverflowCommand, { label: string; icon: ReactNode; run(): void }> = {
		"fit-page": { label: t("settings.pdfFitPage"), icon: <PanelLeft size={14} />, run: onFitPage },
		"rotate-backward": {
			label: t("settings.pdfRotateBackward"),
			icon: <RotateCcw size={14} />,
			run: onRotateBackward,
		},
		"rotate-forward": { label: t("settings.pdfRotateForward"), icon: <RotateCw size={14} />, run: onRotateForward },
		search: { label: t("settings.pdfSearch"), icon: <Search size={14} />, run: onToggleSearch },
		"open-default": {
			label: t("settings.openDefaultApp"),
			icon: <ExternalLink size={14} />,
			run: () => void window.electronAPI?.openWith("", path),
		},
	};

	return (
		<div ref={toolbarRef} className="gui-pdf-toolbar" role="toolbar" aria-label={t("settings.pdfReader")}>
			<button
				type="button"
				className={`gui-btn gui-btn-icon${thumbnails ? " gui-btn-active" : ""}`}
				title={t("settings.pdfThumbnails")}
				aria-label={t("settings.pdfThumbnails")}
				aria-pressed={thumbnails}
				onClick={onToggleThumbnails}
			>
				<PanelLeft size={14} />
			</button>
			<span className="gui-pdf-toolbar-group">
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("settings.pdfPreviousPage")}
					aria-label={t("settings.pdfPreviousPage")}
					disabled={currentPage <= 1}
					onClick={onPreviousPage}
				>
					<ChevronLeft size={14} />
				</button>
				<input
					className="gui-pdf-page-input"
					value={pageInput}
					inputMode="numeric"
					aria-label={t("settings.pdfPageNumber")}
					onChange={event => onPageInput(event.target.value)}
					onBlur={onGoToPage}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault();
							onGoToPage();
						}
					}}
				/>
				<span className="gui-pdf-page-count">/ {totalPages}</span>
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("settings.pdfNextPage")}
					aria-label={t("settings.pdfNextPage")}
					disabled={currentPage >= totalPages}
					onClick={onNextPage}
				>
					<ChevronRight size={14} />
				</button>
			</span>
			<span className="gui-pdf-toolbar-group">
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("settings.pdfZoomOut")}
					aria-label={t("settings.pdfZoomOut")}
					onClick={onZoomOut}
				>
					<ZoomOut size={14} />
				</button>
				<button type="button" className="gui-pdf-zoom-value" title={t("settings.pdfFitWidth")} onClick={onFitWidth}>
					{Math.round(currentZoom * 100)}%
				</button>
				<button
					type="button"
					className="gui-btn gui-btn-icon"
					title={t("settings.pdfZoomIn")}
					aria-label={t("settings.pdfZoomIn")}
					onClick={onZoomIn}
				>
					<ZoomIn size={14} />
				</button>
				<button type="button" className="gui-btn gui-btn-sm" data-pdf-overflow-item="fit-page" onClick={onFitPage}>
					{t("settings.pdfFitPage")}
				</button>
			</span>
			<span className="gui-pdf-toolbar-spacer" />
			<button
				type="button"
				className="gui-btn gui-btn-icon"
				data-pdf-overflow-item="rotate-backward"
				title={t("settings.pdfRotateBackward")}
				onClick={onRotateBackward}
			>
				<RotateCcw size={14} />
			</button>
			<button
				type="button"
				className="gui-btn gui-btn-icon"
				data-pdf-overflow-item="rotate-forward"
				title={t("settings.pdfRotateForward")}
				onClick={onRotateForward}
			>
				<RotateCw size={14} />
			</button>
			<button
				type="button"
				className={`gui-btn gui-btn-icon${searchOpen ? " gui-btn-active" : ""}`}
				data-pdf-overflow-item="search"
				title={t("settings.pdfSearch")}
				aria-label={t("settings.pdfSearch")}
				onClick={onToggleSearch}
			>
				<Search size={14} />
			</button>
			<button
				type="button"
				className="gui-btn gui-btn-icon"
				data-pdf-overflow-item="open-default"
				title={t("settings.openDefaultApp")}
				onClick={commands["open-default"].run}
			>
				<ExternalLink size={14} />
			</button>
			<button
				ref={element => {
					moreRef.current = element;
					moreMenu.anchorRef(element);
				}}
				type="button"
				className="gui-btn gui-btn-icon gui-pdf-more"
				data-pdf-more=""
				hidden={overflow.length === 0}
				title={t("settings.pdfMoreActions")}
				aria-label={t("settings.pdfMoreActions")}
				aria-haspopup="menu"
				aria-expanded={moreOpen}
				onClick={() => setMoreOpen(value => !value)}
			>
				<MoreHorizontal size={14} />
			</button>
			{moreMenu.renderMenu(
				<div className="gui-context-menu gui-pdf-overflow" role="menu" aria-label={t("settings.pdfMoreActions")}>
					{overflow.map(command => (
						<button
							key={command}
							type="button"
							className="gui-menu-item"
							role="menuitem"
							data-pdf-menu-item={command}
							title={commands[command].label}
							onClick={() => {
								setMoreOpen(false);
								commands[command].run();
							}}
						>
							{commands[command].icon}
							<span>{commands[command].label}</span>
						</button>
					))}
				</div>,
			)}
		</div>
	);
}
