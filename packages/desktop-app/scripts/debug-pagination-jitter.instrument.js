// Installs the shadow scrollTop writer on the CURRENT transcript scroller
// (idempotent per element; re-run after re-renders). Returns a status tag.
// NOTE: scrollTop lives on Element.prototype — a single getPrototypeOf hop
// lands on HTMLElement.prototype and finds NO descriptor (that bug poisoned
// the scroller and crashed the whole GUI via error boundary).
const sc = document.querySelector(".gui-transcript") ?? document.querySelector(".tr-root");
if (!sc) return "no-scroller";
if (sc.__jitW) return "already";
let proto = sc;
let desc = undefined;
while (proto && !desc) {
	desc = Object.getOwnPropertyDescriptor(proto, "scrollTop");
	proto = Object.getPrototypeOf(proto);
}
if (!desc || !desc.get || !desc.set) return "no-desc";
if (!window.__jit) window.__jit = { writes: [] };
Object.defineProperty(sc, "scrollTop", {
	get() { return desc.get.call(this); },
	set(v) {
		try {
			window.__jit.writes.push({
				t: Math.round(performance.now()),
				v: Math.round(v),
				prev: Math.round(desc.get.call(this)),
				sh: sc.scrollHeight,
				stack: String(new Error().stack).split("\n").slice(2, 5).join(" | "),
			});
			if (window.__jit.writes.length > 8000) window.__jit.writes.splice(0, 4000);
		} catch (e) {}
		return desc.set.call(this, v);
	},
	configurable: true,
});
sc.__jitW = true;
return "ok";
