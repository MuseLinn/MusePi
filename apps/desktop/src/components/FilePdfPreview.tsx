import { EmbedPDF, type PluginBatchRegistrations } from "@embedpdf/core/react";
import { usePdfiumEngine } from "@embedpdf/engines/react";
import { FontCharset } from "@embedpdf/models";
import { DocumentContent, DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/react";
import { InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { RotatePluginPackage, useRotate } from "@embedpdf/plugin-rotate/react";
import { Scroller, ScrollPluginPackage, useScroll } from "@embedpdf/plugin-scroll/react";
import { SearchLayer, SearchPluginPackage, useSearch } from "@embedpdf/plugin-search/react";
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from "@embedpdf/plugin-selection/react";
import { ThumbImg, type ThumbMeta, ThumbnailPluginPackage, ThumbnailsPane } from "@embedpdf/plugin-thumbnail/react";
import {
	useIsViewportGated,
	useViewportCapability,
	useViewportElement,
	useViewportPlugin,
	useViewportRef,
	ViewportElementContext,
	ViewportPluginPackage,
} from "@embedpdf/plugin-viewport/react";
import { useZoom, ZoomGestureWrapper, ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/react";
import { t } from "@musepi/client-core";
import type { PdfQuoteAnchor } from "@musepi/pi-wire";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { eventMatches } from "../lib/shortcut-registry";
import PdfToolbar from "./PdfToolbar";

const DOCUMENT_ID = "main";

export interface PdfEditorSelection {
	text: string;
	x: number;
	y: number;
	height: number;
	anchor: PdfQuoteAnchor;
}

export interface PdfRestoreRequest {
	anchor: PdfQuoteAnchor;
	quote: string;
	nonce: number;
}

function pdfiumUrl(file: string): string {
	return new URL(`embedpdf/${file}`, window.location.href).toString();
}

function PdfPage({
	documentId,
	pageIndex,
	width,
	height,
}: {
	documentId: string;
	pageIndex: number;
	width: number;
	height: number;
}): ReactNode {
	return (
		<div className="gui-pdf-page" data-pdf-page={pageIndex}>
			<PagePointerProvider documentId={documentId} pageIndex={pageIndex} style={{ width, height }}>
				<RenderLayer documentId={documentId} pageIndex={pageIndex} />
				<SelectionLayer documentId={documentId} pageIndex={pageIndex} />
				<SearchLayer documentId={documentId} pageIndex={pageIndex} />
			</PagePointerProvider>
		</div>
	);
}

function PdfViewportMetrics({ documentId }: { documentId: string }): null {
	const viewportRef = useViewportElement();
	const { plugin } = useViewportPlugin();
	const zoom = useZoom(documentId);
	const zoomProvidesRef = useRef(zoom.provides);
	zoomProvidesRef.current = zoom.provides;
	const zoomReady = zoom.provides !== null;
	useLayoutEffect(() => {
		const viewport = viewportRef?.current;
		if (!viewport || !plugin || !zoomReady) return;
		// Zoom gates page mounting until it receives non-zero document metrics.
		// Publish the real viewport synchronously after layout; a one-off animation
		// frame can otherwise leave the initial zoom gate closed indefinitely.
		plugin.setViewportResizeMetrics(documentId, {
			width: viewport.offsetWidth,
			height: viewport.offsetHeight,
			clientWidth: viewport.clientWidth,
			clientHeight: viewport.clientHeight,
			scrollTop: viewport.scrollTop,
			scrollLeft: viewport.scrollLeft,
			scrollWidth: viewport.scrollWidth,
			scrollHeight: viewport.scrollHeight,
			clientLeft: viewport.clientLeft,
			clientTop: viewport.clientTop,
		});
		// Document loading can finish while the viewport still has zero dimensions.
		// Retry the default automatic mode now that its required metrics exist.
		zoomProvidesRef.current?.requestZoom(ZoomMode.Automatic);
	}, [documentId, plugin, viewportRef, zoomReady]);
	return null;
}

function PdfViewport({ documentId, children }: { documentId: string; children: ReactNode }): ReactNode {
	const viewportRef = useViewportRef(documentId);
	const { provides } = useViewportCapability();
	const isGated = useIsViewportGated(documentId);
	const [viewportGap, setViewportGap] = useState(0);
	useEffect(() => {
		if (provides) setViewportGap(provides.getViewportGap());
	}, [provides]);
	return (
		<ViewportElementContext.Provider value={viewportRef}>
			<div
				ref={viewportRef}
				className="gui-pdf-viewport"
				style={{ width: "100%", height: "100%", overflow: "auto", padding: `${viewportGap}px` }}
			>
				{/* The metrics publisher must stay mounted while zoom gates the pages.
				 * Otherwise an early initial gate also hides the only component that
				 * can publish the dimensions required to release that gate. */}
				<PdfViewportMetrics documentId={documentId} />
				{!isGated && children}
			</div>
		</ViewportElementContext.Provider>
	);
}

function PdfReader({
	path,
	onSelection,
	restore,
}: {
	path: string;
	onSelection: (selection: PdfEditorSelection | null) => void;
	restore?: PdfRestoreRequest;
}): ReactNode {
	const scroll = useScroll(DOCUMENT_ID);
	const zoom = useZoom(DOCUMENT_ID);
	const rotate = useRotate(DOCUMENT_ID);
	const search = useSearch(DOCUMENT_ID);
	const selectionCapability = useSelectionCapability().provides;
	const [pageInput, setPageInput] = useState("1");
	const [thumbnails, setThumbnails] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement | null>(null);
	const pointer = useRef({ x: 0, y: 0 });
	const selectionEpoch = useRef(0);
	const restoringSelection = useRef(false);
	const restoredNonce = useRef<number | null>(null);
	const [restoreNotice, setRestoreNotice] = useState(false);

	useEffect(() => setPageInput(String(scroll.state.currentPage)), [scroll.state.currentPage]);
	useEffect(() => {
		if (searchOpen) searchRef.current?.focus();
	}, [searchOpen]);
	useEffect(() => () => onSelection(null), [onSelection]);

	useEffect(() => {
		if (!selectionCapability) return;
		const scope = selectionCapability.forDocument(DOCUMENT_ID);
		return scope.onSelectionChange(range => {
			if (restoringSelection.current) {
				onSelection(null);
				return;
			}
			const epoch = ++selectionEpoch.current;
			if (!range) {
				onSelection(null);
				return;
			}
			void scope
				.getSelectedText()
				.toPromise()
				.then(parts => {
					if (epoch !== selectionEpoch.current) return;
					const text = parts.join("\n").trim();
					if (!text) {
						onSelection(null);
						return;
					}
					onSelection({
						text,
						x: pointer.current.x,
						y: pointer.current.y - 24,
						height: 24,
						anchor: {
							startPage: Math.min(range.start.page, range.end.page) + 1,
							endPage: Math.max(range.start.page, range.end.page) + 1,
							startIndex: range.start.index,
							endIndex: range.end.index,
							selections: scope.getFormattedSelection(),
						},
					});
				})
				.catch(() => onSelection(null));
		});
	}, [selectionCapability, onSelection]);

	useEffect(() => {
		if (!restore || !selectionCapability || !scroll.provides || restoredNonce.current === restore.nonce) return;
		restoredNonce.current = restore.nonce;
		const scope = selectionCapability.forDocument(DOCUMENT_ID);
		restoringSelection.current = true;
		setRestoreNotice(false);
		scroll.provides.scrollToPage({ pageNumber: restore.anchor.startPage });
		void scope
			.setSelection({
				start: { page: restore.anchor.startPage - 1, index: restore.anchor.startIndex },
				end: { page: restore.anchor.endPage - 1, index: restore.anchor.endIndex },
			})
			.toPromise()
			.catch(() => {
				const query = restore.quote.normalize("NFKC").replace(/\s+/g, " ").trim();
				if (query && search.provides) {
					search.provides.startSearch();
					search.provides.searchAllPages(query);
				}
				setRestoreNotice(true);
			})
			.finally(() => {
				restoringSelection.current = false;
			});
	}, [restore, selectionCapability, scroll.provides, search.provides]);

	const goToPage = (): void => {
		const page = Number(pageInput);
		if (Number.isInteger(page) && page >= 1 && page <= scroll.state.totalPages) {
			scroll.provides?.scrollToPage({ pageNumber: page });
		} else setPageInput(String(scroll.state.currentPage));
	};
	const runSearch = (): void => {
		const keyword = query.trim();
		if (!keyword) return;
		search.provides?.startSearch();
		search.provides?.searchAllPages(keyword);
	};
	const closeSearch = (): void => {
		search.provides?.stopSearch();
		setSearchOpen(false);
	};
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (eventMatches(event, "pdf-find")) {
			event.preventDefault();
			event.stopPropagation();
			setSearchOpen(true);
		} else if (eventMatches(event, "pdf-zoom-in")) {
			event.preventDefault();
			event.stopPropagation();
			zoom.provides?.zoomIn();
		} else if (eventMatches(event, "pdf-zoom-out")) {
			event.preventDefault();
			event.stopPropagation();
			zoom.provides?.zoomOut();
		} else if (eventMatches(event, "pdf-zoom-reset")) {
			event.preventDefault();
			event.stopPropagation();
			zoom.provides?.requestZoom(ZoomMode.FitWidth);
		}
	};

	return (
		<div
			className="gui-pdf-reader"
			tabIndex={0}
			onKeyDown={onKeyDown}
			onPointerUp={event => {
				pointer.current = { x: event.clientX, y: event.clientY };
			}}
		>
			<PdfToolbar
				path={path}
				pageInput={pageInput}
				currentPage={scroll.state.currentPage}
				totalPages={scroll.state.totalPages}
				currentZoom={zoom.state.currentZoomLevel}
				thumbnails={thumbnails}
				searchOpen={searchOpen}
				onPageInput={setPageInput}
				onGoToPage={goToPage}
				onPreviousPage={() => scroll.provides?.scrollToPreviousPage()}
				onNextPage={() => scroll.provides?.scrollToNextPage()}
				onToggleThumbnails={() => setThumbnails(value => !value)}
				onZoomOut={() => zoom.provides?.zoomOut()}
				onZoomIn={() => zoom.provides?.zoomIn()}
				onFitWidth={() => zoom.provides?.requestZoom(ZoomMode.FitWidth)}
				onFitPage={() => zoom.provides?.requestZoom(ZoomMode.FitPage)}
				onRotateBackward={() => rotate.provides?.rotateBackward()}
				onRotateForward={() => rotate.provides?.rotateForward()}
				onToggleSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
			/>
			{restoreNotice && (
				<div className="gui-pdf-restore-notice" role="status">
					{t("settings.pdfLocateFallback")}
				</div>
			)}
			{searchOpen && (
				<div className="gui-pdf-search" role="search">
					<Search size={13} />
					<input
						ref={searchRef}
						value={query}
						placeholder={t("settings.pdfSearchPlaceholder")}
						onChange={event => setQuery(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault();
								if (event.shiftKey) search.provides?.previousResult();
								else if (search.state.query === query.trim() && search.state.total > 0)
									search.provides?.nextResult();
								else runSearch();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								closeSearch();
							}
						}}
					/>
					<span className="gui-pdf-search-count">
						{search.state.loading
							? t("settings.pdfSearching")
							: search.state.total > 0
								? `${search.state.activeResultIndex + 1} / ${search.state.total}`
								: search.state.query
									? t("settings.pdfNoResults")
									: ""}
					</span>
					<button
						type="button"
						className="gui-btn gui-btn-icon"
						title={t("settings.pdfPreviousResult")}
						onClick={() => search.provides?.previousResult()}
					>
						<ChevronUp size={13} />
					</button>
					<button
						type="button"
						className="gui-btn gui-btn-icon"
						title={t("settings.pdfNextResult")}
						onClick={() => search.provides?.nextResult()}
					>
						<ChevronDown size={13} />
					</button>
					<button type="button" className="gui-btn gui-btn-icon" title={t("settings.close")} onClick={closeSearch}>
						<X size={13} />
					</button>
				</div>
			)}
			<div className="gui-pdf-content">
				{thumbnails && (
					<aside className="gui-pdf-thumbnails" aria-label={t("settings.pdfThumbnails")}>
						<ThumbnailsPane documentId={DOCUMENT_ID}>
							{(meta: ThumbMeta) => <ThumbImg documentId={DOCUMENT_ID} meta={meta} />}
						</ThumbnailsPane>
					</aside>
				)}
				<PdfViewport documentId={DOCUMENT_ID}>
					<ZoomGestureWrapper documentId={DOCUMENT_ID}>
						<Scroller
							documentId={DOCUMENT_ID}
							renderPage={page => (
								<PdfPage
									documentId={DOCUMENT_ID}
									pageIndex={page.pageIndex}
									width={page.width}
									height={page.height}
								/>
							)}
						/>
					</ZoomGestureWrapper>
				</PdfViewport>
			</div>
		</div>
	);
}

interface PdfPreviewProps {
	data: ArrayBuffer;
	name: string;
	path: string;
	onSelection: (selection: PdfEditorSelection | null) => void;
	restore?: PdfRestoreRequest;
}

const PDF_LOAD_TIMEOUT_MS = 30_000;

/** Resettable deadline for engine and document loading. A retry remounts the
 * owner, which also clears the previous deadline. */
export function usePdfLoadTimeout(timeoutMs: number = PDF_LOAD_TIMEOUT_MS): boolean {
	const [loadTimedOut, setLoadTimedOut] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setLoadTimedOut(true), timeoutMs);
		return () => window.clearTimeout(timer);
	}, [timeoutMs]);
	return loadTimedOut;
}

function PdfDocument({
	path,
	onSelection,
	restore,
	onRetry,
}: Pick<PdfPreviewProps, "path" | "onSelection" | "restore"> & { onRetry(): void }): ReactNode {
	const loadTimedOut = usePdfLoadTimeout();
	return (
		<DocumentContent documentId={DOCUMENT_ID}>
			{({ documentState, isLoading, isError, isLoaded }) => {
				if (isLoading && !loadTimedOut) return <div className="gui-pdf-status">{t("settings.pdfLoading")}</div>;
				if (isError || (isLoading && loadTimedOut)) {
					return (
						<div className="gui-pdf-status gui-pdf-status--error" role="alert">
							<strong>{t("settings.pdfOpenFailed")}</strong>
							<span>
								{isError ? (documentState.error ?? t("settings.pdfInvalid")) : t("settings.pdfLoadTimeout")}
							</span>
							<div className="gui-pdf-error-actions">
								<button type="button" className="gui-btn gui-btn-sm" onClick={onRetry}>
									{t("settings.retry")}
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-sm"
									onClick={() => void window.electronAPI?.openWith("", path)}
								>
									{t("settings.openDefaultApp")}
								</button>
							</div>
						</div>
					);
				}
				return isLoaded ? <PdfReader path={path} onSelection={onSelection} restore={restore} /> : null;
			}}
		</DocumentContent>
	);
}

function PdfEngine({
	data,
	name,
	path,
	onSelection,
	restore,
	onRetry,
}: PdfPreviewProps & { onRetry(): void }): ReactNode {
	const wasmUrl = useMemo(() => pdfiumUrl("pdfium.wasm"), []);
	// usePdfiumEngine keys its lifecycle on this object. A fresh object per
	// render destroys the engine and restarts WASM initialization forever.
	const fontFallback = useMemo(
		() => ({
			baseUrl: pdfiumUrl("fonts/"),
			fonts: {
				[FontCharset.ANSI]: "NotoSans-Regular.ttf",
				[FontCharset.GB2312]: "NotoSansHans-Regular.otf",
			},
		}),
		[],
	);
	const loadTimedOut = usePdfLoadTimeout();
	const { engine, isLoading, error } = usePdfiumEngine({ wasmUrl, worker: true, fontFallback });
	const plugins = useMemo<PluginBatchRegistrations>(
		// EmbedPDF 2.15.1 declares its heterogeneous registry with an invariant
		// `unknown` reducer state. The concrete plugin packages are valid at runtime;
		// contain that upstream variance issue at this one library boundary.
		() =>
			[
				{
					package: DocumentManagerPluginPackage,
					config: {
						maxDocuments: 1,
						initialDocuments: [{ buffer: data, name, documentId: DOCUMENT_ID, autoActivate: true }],
					},
				},
				{ package: ViewportPluginPackage },
				{ package: ScrollPluginPackage },
				{ package: RenderPluginPackage, config: { withAnnotations: true } },
				{ package: InteractionManagerPluginPackage },
				{ package: SelectionPluginPackage, config: { maxCachedGeometries: 50 } },
				{ package: ZoomPluginPackage },
				{ package: SearchPluginPackage },
				{ package: RotatePluginPackage },
				{ package: ThumbnailPluginPackage },
			] as PluginBatchRegistrations,
		[data, name],
	);
	if (isLoading && !loadTimedOut) return <div className="gui-pdf-status">{t("settings.pdfLoading")}</div>;
	if (error || !engine || (isLoading && loadTimedOut)) {
		return (
			<div className="gui-pdf-status gui-pdf-status--error" role="alert">
				<strong>{t("settings.pdfEngineFailed")}</strong>
				<span>{loadTimedOut && !error ? t("settings.pdfLoadTimeout") : error?.message}</span>
				<div className="gui-pdf-error-actions">
					<button type="button" className="gui-btn gui-btn-sm" onClick={onRetry}>
						{t("settings.retry")}
					</button>
					<button
						type="button"
						className="gui-btn gui-btn-sm"
						onClick={() => void window.electronAPI?.openWith("", path)}
					>
						{t("settings.openDefaultApp")}
					</button>
				</div>
			</div>
		);
	}
	return (
		<EmbedPDF engine={engine} plugins={plugins}>
			<PdfDocument path={path} onSelection={onSelection} restore={restore} onRetry={onRetry} />
		</EmbedPDF>
	);
}

export default function FilePdfPreview(props: PdfPreviewProps): ReactNode {
	const [attempt, setAttempt] = useState(0);
	return <PdfEngine key={`${props.path}:${attempt}`} {...props} onRetry={() => setAttempt(value => value + 1)} />;
}
