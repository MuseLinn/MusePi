interface DictationTarget {
	dom: HTMLElement;
	toggle: () => void;
	isActive: () => boolean;
}

const targets = new Set<DictationTarget>();
let unsubscribe: (() => void) | null = null;

function isFocused(target: DictationTarget): boolean {
	return target.dom.contains(document.activeElement);
}

function syncState(): void {
	const api = window.electronAPI?.dictationTarget;
	if (!api) return;
	const state = {
		focused: [...targets].some(isFocused),
		active: [...targets].some(target => target.isActive()),
	};
	void api.setState(state).catch(() => {});
}

function stopListening(): void {
	unsubscribe?.();
	unsubscribe = null;
	document.removeEventListener("focusin", syncState, true);
}

function ensureListening(): void {
	if (unsubscribe || targets.size === 0) return;
	const api = window.electronAPI?.dictationTarget;
	if (!api) return;
	unsubscribe = api.onToggle(() => {
		const target = [...targets].find(entry => entry.isActive()) ?? [...targets].find(isFocused);
		target?.toggle();
	});
	document.addEventListener("focusin", syncState, true);
}

export function registerGlobalDictationTarget(
	dom: HTMLElement,
	toggle: () => void,
	isActive: () => boolean,
): () => void {
	if (!window.electronAPI?.dictationTarget) return () => {};
	const target = { dom, toggle, isActive };
	targets.add(target);
	ensureListening();
	const onFocusOut = (): void => queueMicrotask(syncState);
	dom.addEventListener("focusout", onFocusOut);
	syncState();
	return () => {
		targets.delete(target);
		dom.removeEventListener("focusout", onFocusOut);
		if (targets.size === 0) stopListening();
		syncState();
	};
}
