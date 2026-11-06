import { t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../vendor/oc-icons";

interface AnchorRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

function contains(rect: AnchorRect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}

function sameRect(a: AnchorRect, b: AnchorRect): boolean {
	return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** A modal surface owns the pointer; its own controls decide what a file drop means. */
function overModal(event: DragEvent): boolean {
	const target = event.target as Element | null;
	return (
		typeof target?.closest === "function" &&
		target.closest(".gui-dialog-backdrop, .gui-dialog, [aria-modal='true']") !== null
	);
}

/**
 * Drop anchor over the chat card (Kimi / VS Code "drop to attach" parity).
 *
 * Dragging files from the OS anywhere over the window armed this surface
 * before: only the composer textarea accepted a drop, and an unhandled file
 * drop makes Chromium navigate the window to the file. The anchor therefore
 * claims every *unclaimed* file drag for the window, shows where the release
 * lands, and hands the files to the composer mounted in the active scene.
 *
 * Ownership order matters. A surface that already prevented dragover's default
 * (a plugin-install dropzone, a composer textarea, a file pane) keeps its own
 * dropEffect: overwriting it with "none" cancels that surface's drop event in
 * Chromium. A modal dialog owns every pointer position it covers, so no chat
 * attachment is staged there either.
 *
 * The overlay is pointer-transparent and portalled to the document: it must
 * not become the drop target itself, or it would cover the very card it is
 * describing (and the browser page host).
 */
export function ChatDropAnchor({
	resolveTarget,
	onFiles,
}: {
	/** The card the drop covers right now (session column or welcome card). */
	resolveTarget(): HTMLElement | null;
	/** Stage the dropped files on the composing surface. */
	onFiles(files: File[]): void;
}): ReactNode {
	const [anchor, setAnchor] = useState<AnchorRect | null>(null);
	const shownRef = useRef(false);

	const measure = useCallback((): AnchorRect | null => {
		const target = resolveTarget();
		if (!target) return null;
		const rect = target.getBoundingClientRect();
		return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
	}, [resolveTarget]);

	useEffect(() => {
		const show = (rect: AnchorRect): void => {
			shownRef.current = true;
			// One layout read feeds both the hit test and the painted rect. The
			// card can move mid-drag (right panel spring, scene cross-fade,
			// window resize), so keep the painted rect in sync with it; the
			// identity check keeps dragover from re-rendering every frame.
			setAnchor(prev => (prev !== null && sameRect(prev, rect) ? prev : rect));
		};
		const hide = (): void => {
			if (!shownRef.current) return;
			shownRef.current = false;
			setAnchor(null);
		};
		const hasFiles = (event: DragEvent): boolean => {
			const types = event.dataTransfer?.types;
			return types !== undefined && [...types].includes("Files");
		};

		const onDragEnter = (event: DragEvent): void => {
			if (!hasFiles(event) || overModal(event)) return;
			const rect = measure();
			if (rect && contains(rect, event.clientX, event.clientY)) show(rect);
		};
		const onDragOver = (event: DragEvent): void => {
			if (!hasFiles(event)) return;
			// A surface below the pointer claimed the drag already. Leave its
			// dropEffect alone; stepping on it would silently cancel its drop.
			const claimed = event.defaultPrevented;
			const rect = measure();
			const blocked = overModal(event);
			const overCard = rect !== null && contains(rect, event.clientX, event.clientY);
			if (!claimed) {
				// Still claim unclaimed drags: without this Chromium navigates
				// the whole window to the dropped file.
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = overCard && !blocked ? "copy" : "none";
			}
			if (blocked) {
				hide();
				return;
			}
			if (overCard && rect) show(rect);
			else hide();
		};
		const onDragLeave = (event: DragEvent): void => {
			// dragleave also fires when crossing child boundaries, so the
			// pointer position — not the event target — decides.
			const rect = measure();
			if (!rect || !contains(rect, event.clientX, event.clientY)) hide();
		};
		const onDrop = (event: DragEvent): void => {
			if (!hasFiles(event)) return;
			// The composer's own drop handler already staged these files and
			// prevented the default; staging them again here would duplicate
			// every chip dropped straight onto the textarea.
			if (event.defaultPrevented) {
				hide();
				return;
			}
			event.preventDefault();
			const rect = measure();
			const blocked = overModal(event);
			hide();
			if (blocked || !rect || !contains(rect, event.clientX, event.clientY)) return;
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length > 0) onFiles(files);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || !shownRef.current) return;
			// Claim the key: an unclaimed bare Escape leaks into the window
			// shortcut and interrupts the running turn (docs/gui-design.md §5e).
			event.preventDefault();
			hide();
		};

		window.addEventListener("dragenter", onDragEnter);
		window.addEventListener("dragover", onDragOver);
		window.addEventListener("dragleave", onDragLeave);
		window.addEventListener("dragend", hide);
		window.addEventListener("drop", onDrop);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", hide);
		return () => {
			window.removeEventListener("dragenter", onDragEnter);
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("dragleave", onDragLeave);
			window.removeEventListener("dragend", hide);
			window.removeEventListener("drop", onDrop);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", hide);
		};
	}, [measure, onFiles]);

	if (!anchor) return null;
	return createPortal(
		<div
			className="gui-drop-anchor"
			style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }}
			aria-hidden
		>
			<div className="gui-drop-anchor-panel">
				<Icon name="file-add" className="gui-drop-anchor-icon" />
				<span className="gui-drop-anchor-label">{t("general.dropFilesToAttach")}</span>
			</div>
		</div>,
		document.body,
	);
}
