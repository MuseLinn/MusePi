/**
 * A mermaid diagram as React nodes.
 *
 * The diagram's SVG is produced by the host (beautiful-mermaid synchronously,
 * official mermaid when the sync renderer cannot draw the type), but the block
 * wrapper and its toolbar belong to React. Two things follow from that:
 *
 * - A finished diagram is never rebuilt by a stream tick, so its zoom level and
 *   scroll position survive — the string version re-serialized it every frame.
 * - The asynchronous render is awaited HERE, as state, instead of being patched
 *   into the DOM by a MutationObserver watching for placeholders. A block that
 *   knows it is pending cannot be mistaken for a stale one.
 */

import { Check, Copy, Download, Maximize2, ZoomIn, ZoomOut } from "lucide";
import { MorphIcon } from "morphicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MarkdownBlockProps } from "../registry";

export interface MarkdownMermaidBlockProps extends MarkdownBlockProps {
	/** Source of the diagram, as it was fenced. */
	diagram: string;
	/** Synchronous render (SVG markup, or `<pre>` in ASCII mode). */
	svg: string | null;
	/** True when the sync renderer produced a usable diagram. */
	usable: boolean;
	/** Resolves the diagram when `usable` is false (official mermaid). */
	renderAsync?(source: string): Promise<string>;
	/** Fallback markup when every renderer fails. */
	fallback?(source: string): string;
}

export function MarkdownMermaidBlock(props: MarkdownBlockProps): ReactNode {
	if (props.diagram === undefined) return null;
	return <MermaidBlock {...props} diagram={props.diagram} />;
}

function MermaidBlock({
	diagram,
	svg,
	usable,
	renderAsync,
	fallback,
	labels,
}: MarkdownBlockProps & { diagram: string; svg?: string | null; usable?: boolean }): ReactNode {
	const [resolved, setResolved] = useState<string | null>(usable ? (svg ?? null) : null);
	const [failed, setFailed] = useState(false);
	const [zoom, setZoom] = useState(1);
	const [copied, setCopied] = useState(false);
	const [full, setFull] = useState(false);
	const copyTimer = useRef<number | null>(null);

	// The type the sync renderer cannot draw resolves once, behind an async
	// renderer; a stale result is dropped by the `live` flag rather than by
	// comparing DOM nodes.
	useEffect(() => {
		if (usable) {
			setResolved(svg ?? null);
			return;
		}
		if (!renderAsync) {
			setFailed(true);
			return;
		}
		let live = true;
		void renderAsync(diagram)
			.then(html => {
				if (live) setResolved(html);
			})
			.catch(() => {
				if (live) setFailed(true);
			});
		return () => {
			live = false;
		};
	}, [diagram, svg, usable, renderAsync]);

	useEffect(
		() => () => {
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
		},
		[],
	);

	const copySource = (): void => {
		void navigator.clipboard.writeText(diagram).then(() => {
			setCopied(true);
			if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
			copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
		});
	};

	if (failed && fallback) {
		// Every renderer gave up: show the source, as a plain fence would.
		return <span dangerouslySetInnerHTML={{ __html: fallback(diagram) }} />;
	}

	const zoomBy = (factor: number): void => setZoom(value => Math.min(4, Math.max(0.5, value * factor)));

	return (
		<div className="tr-mermaid-block">
			<div className="tr-mermaid-bar">
				<button
					type="button"
					className="tr-code-btn tr-mermaid-copy"
					aria-label={copied ? labels.copied : labels.copy}
					title={copied ? labels.copied : labels.copy}
					onClick={copySource}
				>
					<MorphIcon icon={copied ? Check : Copy} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-mermaid-zoom"
					aria-label={labels.zoomIn}
					title={labels.zoomIn}
					onClick={() => zoomBy(1.2)}
				>
					<MorphIcon icon={ZoomIn} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-mermaid-zoom"
					aria-label={labels.zoomOut}
					title={labels.zoomOut}
					onClick={() => zoomBy(1 / 1.2)}
				>
					<MorphIcon icon={ZoomOut} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-mermaid-fs"
					aria-label={labels.expand}
					title={labels.expand}
					onClick={() => setFull(true)}
				>
					<MorphIcon icon={Maximize2} size={14} spring="snappy" />
				</button>
				<button
					type="button"
					className="tr-code-btn tr-mermaid-dl"
					aria-label={labels.download}
					title={labels.download}
					onClick={() => {
						const target = document.querySelector<SVGElement>(`[data-mermaid-svg="${diagram.length}"] svg`);
						if (!target) return;
						const xml = new XMLSerializer().serializeToString(target);
						const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
						const link = document.createElement("a");
						link.href = url;
						link.download = "diagram.svg";
						link.click();
						URL.revokeObjectURL(url);
					}}
				>
					<MorphIcon icon={Download} size={14} spring="snappy" />
				</button>
			</div>
			{resolved === null ? (
				<div className="tr-mermaid-loading">{labels.renderingDiagram}</div>
			) : (
				<div
					className="tr-mermaid"
					data-mermaid-svg={String(diagram.length)}
					// The SVG is the renderer's; the wrapper is React's. Zoom is a
					// layout scale on the wrapper so the diagram scrolls when enlarged.
					style={zoom === 1 ? undefined : { zoom }}
					dangerouslySetInnerHTML={{ __html: resolved }}
				/>
			)}
			{full && resolved !== null && (
				// Fullscreen keeps the same markup with its own zoom, on the shared
				// frosted overlay chrome.
				<div
					className="tr-widget-fs"
					role="dialog"
					aria-modal="true"
					onClick={event => event.target === event.currentTarget && setFull(false)}
				>
					<button
						type="button"
						className="tr-widget-fs-x"
						aria-label={labels.close}
						onClick={() => setFull(false)}
					>
						<MorphIcon icon={Maximize2} size={16} spring="snappy" />
					</button>
					<div className="tr-mm-lb-body">
						<div className="tr-mm-lb-scroll">
							<div className="tr-mm-lb-svg" dangerouslySetInnerHTML={{ __html: resolved }} />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
