let maximized = false;
const listeners = new Set<() => void>();
const animating = new WeakSet<HTMLElement>();

export function getPanelMaximized(): boolean {
	return maximized;
}

export function subscribePanelMaximize(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function setPanelMaximized(next: boolean): void {
	if (next === maximized) return;
	maximized = next;
	for (const listener of listeners) listener();
}

function writeMaximizedGeometry(panel: HTMLElement): void {
	const column = panel.closest<HTMLElement>(".gui-chat-surface")?.querySelector<HTMLElement>(".gui-chat-column");
	const rect = column?.getBoundingClientRect();
	if (!rect) return;
	panel.style.setProperty("--pane-max-left", `${rect.left}px`);
	panel.style.setProperty("--pane-max-top", `${rect.top}px`);
	panel.style.setProperty("--pane-max-width", `${rect.width}px`);
	panel.style.setProperty("--pane-max-height", `${rect.height}px`);
}

function writeButtonState(panel: HTMLElement, next: boolean): void {
	for (const button of panel.querySelectorAll<HTMLButtonElement>(".gui-pane-tool")) {
		if (!button.querySelector('use[href="#oc-fullscreen"], use[href="#oc-fullscreen-exit"]')) continue;
		button.querySelector(".gui-icon-morph")?.classList.toggle("is-on", next);
	}
}

/** Host-owned visual commit. It works with or without a Cordis panel renderer. */
export function updatePanelMaximized(panel: HTMLElement, next: boolean): void {
	if (animating.has(panel)) return;
	// FLIP starts at the docked box. Measuring after the class toggle would make
	// maximize a no-op animation because first and last are already identical.
	const first = panel.getBoundingClientRect();
	setPanelMaximized(next);
	// The docked inline width would otherwise override --pane-max-width and
	// leave only left/top animating. Clear it before measuring the target box.
	if (next) panel.style.removeProperty("width");
	panel.classList.toggle("gui-pane-right--maximized", next);
	writeMaximizedGeometry(panel);
	writeButtonState(panel, next);
	const motionOff =
		(document.body.closest(".gui-motion-off") ?? document.querySelector(".gui-motion-off")) !== null ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (motionOff) return;

	panel.style.transition = "none";
	const last = panel.getBoundingClientRect();
	if (next) {
		panel.style.left = `${first.left}px`;
		panel.style.top = `${first.top}px`;
		panel.style.width = `${first.width}px`;
		panel.style.height = `${first.height}px`;
	} else {
		panel.style.width = `${first.width}px`;
		panel.style.height = `${first.height}px`;
		const pinned = panel.getBoundingClientRect();
		panel.style.left = `${first.left - pinned.left}px`;
		panel.style.top = `${first.top - pinned.top}px`;
	}
	void panel.getBoundingClientRect();
	panel.style.transition =
		"left 260ms var(--spring), top 260ms var(--spring), width 260ms var(--spring), height 260ms var(--spring)";
	panel.style.left = next ? `${last.left}px` : "0px";
	panel.style.top = next ? `${last.top}px` : "0px";
	panel.style.width = `${last.width}px`;
	panel.style.height = `${last.height}px`;
	animating.add(panel);
	const finish = (): void => {
		for (const property of ["left", "top", "width", "height", "transition"]) panel.style.removeProperty(property);
		if (!next) panel.style.width = `${last.width}px`;
		animating.delete(panel);
	};
	const onEnd = (event: TransitionEvent): void => {
		if (event.target !== panel || event.propertyName !== "width") return;
		panel.removeEventListener("transitionend", onEnd);
		finish();
	};
	panel.addEventListener("transitionend", onEnd);
	window.setTimeout(() => {
		panel.removeEventListener("transitionend", onEnd);
		if (animating.has(panel)) finish();
	}, 300);
}

/** Native host controller; no React effect or Cordis page state is involved. */
export function installPanelMaximizeController(): () => void {
	const onClick = (event: MouseEvent): void => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>(".gui-pane-tool");
		if (!button?.querySelector('use[href="#oc-fullscreen"], use[href="#oc-fullscreen-exit"]')) return;
		const panel = button.closest<HTMLElement>(".gui-pane-right--inner");
		if (!panel) return;
		event.stopPropagation();
		updatePanelMaximized(panel, !panel.classList.contains("gui-pane-right--maximized"));
	};
	const onResize = (): void => {
		const panel = document.querySelector<HTMLElement>(".gui-pane-right--maximized");
		if (panel) writeMaximizedGeometry(panel);
	};
	document.addEventListener("click", onClick, true);
	window.addEventListener("resize", onResize);
	return () => {
		document.removeEventListener("click", onClick, true);
		window.removeEventListener("resize", onResize);
	};
}
