import type { OfficeQuoteAnchor } from "@musepi/pi-wire";

/** Anchor of a selectable Office element in the editing surface. */
export interface OfficeSelectionLocation {
	element: HTMLElement;
	anchor: OfficeQuoteAnchor;
}

/** Map a DOM node inside the editor surface to its quote anchor. */
export function officeLocation(node: Node | null): OfficeSelectionLocation | null {
	const element = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>(
		"[data-office-kind]",
	);
	if (!element) return null;
	const kind = element.dataset.officeKind;
	if (kind === "word") return { element, anchor: { kind, paragraphId: Number(element.dataset.paragraphId) } };
	if (kind === "presentation") {
		return {
			element,
			anchor: { kind, slide: Number(element.dataset.slide), shapeId: element.dataset.shapeId ?? "" },
		};
	}
	if (kind === "workbook") {
		return {
			element,
			anchor: {
				kind,
				sheet: element.dataset.sheet ?? "",
				startCell: element.dataset.cell ?? "",
				endCell: element.dataset.cell ?? "",
			},
		};
	}
	return null;
}

export interface OfficeRestoreRequest {
	anchor: OfficeQuoteAnchor;
	quote: string;
	nonce: number;
}

/** Scroll to an anchored element and select the quoted text when it is found. */
export function restoreOfficeElement(root: HTMLElement, request: OfficeRestoreRequest): boolean {
	const element = Array.from(root.querySelectorAll<HTMLElement>("[data-office-kind]")).find(candidate => {
		const anchor = request.anchor;
		if (anchor.kind === "word") {
			return candidate.dataset.officeKind === "word" && Number(candidate.dataset.paragraphId) === anchor.paragraphId;
		}
		if (anchor.kind === "presentation") {
			return (
				candidate.dataset.officeKind === "presentation" &&
				Number(candidate.dataset.slide) === anchor.slide &&
				candidate.dataset.shapeId === anchor.shapeId
			);
		}
		return (
			candidate.dataset.officeKind === "workbook" &&
			candidate.dataset.sheet === anchor.sheet &&
			candidate.dataset.cell === anchor.startCell
		);
	});
	if (!element) return false;
	element.scrollIntoView({ block: "center" });
	const range = document.createRange();
	const quote = request.quote.trim();
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	const text = nodes.map(node => node.data).join("");
	const start = quote ? text.indexOf(quote) : -1;
	if (start >= 0) {
		let offset = 0;
		let started = false;
		for (const node of nodes) {
			const end = offset + node.data.length;
			if (!started && start < end) {
				range.setStart(node, start - offset);
				started = true;
			}
			if (started && start + quote.length <= end) {
				range.setEnd(node, start + quote.length - offset);
				break;
			}
			offset = end;
		}
	} else range.selectNodeContents(element);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	return true;
}
