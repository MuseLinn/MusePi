// Visual-anchoring check: samples the text at the viewport center every
// POLL_MS while wheeling up. If prepend anchoring works, the center text
// stays stable across prepends (it only changes when the user's own wheel
// scrolls past it).
const sc = document.querySelector(".gui-transcript") ?? document.querySelector(".tr-root");
if (!sc) return null;
const cx = sc.clientWidth / 2;
const cy = sc.clientHeight / 2;
const el = document.elementFromPoint(
	(sc.getBoundingClientRect?.().left ?? 0) + cx,
	(sc.getBoundingClientRect?.().top ?? 0) + cy,
);
return {
	t: Math.round(performance.now()),
	st: Math.round(sc.scrollTop),
	sh: sc.scrollHeight,
	centerText: (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
	centerEl: el ? String(el.className).slice(0, 40) : "none",
};
