import { t } from "@musepi/client-core";

function outerWidth(element: HTMLElement): number {
	const style = getComputedStyle(element);
	return (
		element.getBoundingClientRect().width +
		(Number.parseFloat(style.marginLeft) || 0) +
		(Number.parseFloat(style.marginRight) || 0)
	);
}

/** Keep Crepe's Vue-owned commands in place. Only a suffix of the original
 * buttons is hidden; menu copies forward activation to those originals. */
export function installMarkdownToolbarOverflow(root: HTMLElement): () => void {
	const inner = root.querySelector<HTMLElement>(".milkdown-top-bar .top-bar-inner");
	if (!inner) return () => {};

	const more = document.createElement("button");
	more.type = "button";
	more.className = "gui-filepane-markdown-more";
	more.setAttribute("aria-label", t("markdownMoreActions"));
	more.setAttribute("title", t("markdownMoreActions"));
	more.setAttribute("aria-haspopup", "menu");
	more.setAttribute("aria-expanded", "false");
	more.hidden = true;
	more.innerHTML =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';

	const menu = document.createElement("div");
	menu.className = "gui-menu-popup gui-filepane-markdown-overflow";
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", t("markdownMoreActions"));
	menu.hidden = true;
	document.body.append(menu);
	inner.append(more);

	let frame: number | null = null;
	let disposed = false;
	const isOpen = (): boolean => !menu.hidden;
	const close = (): void => {
		menu.hidden = true;
		menu.classList.remove("gui-menu-popup--entered");
		more.setAttribute("aria-expanded", "false");
	};
	const items = (): HTMLElement[] =>
		Array.from(inner.querySelectorAll<HTMLElement>(":scope > .top-bar-item"));

	const position = (): void => {
		const anchor = more.getBoundingClientRect();
		const width = menu.offsetWidth;
		const height = menu.offsetHeight;
		const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
		const below = anchor.bottom + 6;
		const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6);
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	};

	const open = (): void => {
		menu.replaceChildren();
		for (const original of items()) {
			if (!original.hidden) continue;
			const entry = document.createElement("button");
			entry.type = "button";
			entry.className = "gui-filepane-markdown-overflow-item";
			entry.setAttribute("role", "menuitem");
			const icon = document.createElement("span");
			icon.className = "gui-filepane-markdown-overflow-icon";
			icon.innerHTML = original.innerHTML;
			const label = document.createElement("span");
			label.textContent = original.getAttribute("aria-label") ?? original.getAttribute("title") ?? "";
			entry.append(icon, label);
			entry.addEventListener("pointerdown", event => event.preventDefault());
			entry.addEventListener("click", event => {
				event.preventDefault();
				event.stopPropagation();
				original.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
				close();
			});
			menu.append(entry);
		}
		if (!menu.childElementCount) return;
		menu.hidden = false;
		position();
		menu.classList.add("gui-menu-popup--entered");
		more.setAttribute("aria-expanded", "true");
	};

	const layout = (): void => {
		frame = null;
		if (disposed) return;
		close();
		const all = items();
		const heading = inner.querySelector<HTMLElement>(":scope > .top-bar-heading-selector");
		for (const divider of inner.querySelectorAll<HTMLElement>(":scope > .top-bar-divider")) divider.hidden = true;
		for (const item of all) item.hidden = false;
		more.hidden = true;
		const headingWidth = heading ? outerWidth(heading) : 0;
		const fullWidth = headingWidth + all.reduce((total, item) => total + outerWidth(item), 0);
		if (fullWidth <= inner.clientWidth) {
			more.dataset.overflowCount = "0";
			return;
		}

		more.hidden = false;
		const limit = inner.clientWidth - outerWidth(more);
		let used = headingWidth;
		let overflowing = false;
		let count = 0;
		for (const item of all) {
			const width = outerWidth(item);
			if (!overflowing && used + width <= limit) {
				used += width;
			} else {
				overflowing = true;
				item.hidden = true;
				count += 1;
			}
		}
		more.dataset.overflowCount = String(count);
	};
	const schedule = (): void => {
		if (frame !== null || disposed) return;
		frame = requestAnimationFrame(layout);
	};
	const onMorePointerDown = (event: PointerEvent): void => event.preventDefault();
	const onMoreClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		if (isOpen()) close();
		else open();
	};
	const onOutsidePointerDown = (event: PointerEvent): void => {
		if (!isOpen()) return;
		const target = event.target;
		if (target instanceof Node && (menu.contains(target) || more.contains(target))) return;
		close();
	};
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || !isOpen()) return;
		event.preventDefault();
		event.stopPropagation();
		close();
		more.focus();
	};
	const onScroll = (): void => close();

	more.addEventListener("pointerdown", onMorePointerDown);
	more.addEventListener("click", onMoreClick);
	document.addEventListener("pointerdown", onOutsidePointerDown, true);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", schedule);
	const mutations = new MutationObserver(schedule);
	mutations.observe(inner, { childList: true });
	const resize = new ResizeObserver(schedule);
	resize.observe(inner);
	layout();

	return () => {
		disposed = true;
		if (frame !== null) cancelAnimationFrame(frame);
		mutations.disconnect();
		resize.disconnect();
		more.removeEventListener("pointerdown", onMorePointerDown);
		more.removeEventListener("click", onMoreClick);
		document.removeEventListener("pointerdown", onOutsidePointerDown, true);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", schedule);
		more.remove();
		menu.remove();
	};
}
