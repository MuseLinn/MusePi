// Liquid-glass edge refraction (settings → 外观 glass pipeline companion).
//
// Frosted glass blurs whatever sits behind a pane; it never bends light at
// the pane's rim, which is what reads as 磨砂毛玻璃 instead of liquid
// glass. The recipe ported here (no runtime dependency):
//
//   1. A dedicated warp layer (::before, see .gui-liquid-glass in
//      gui-base.css) carries BOTH backdrop-filter and an SVG displacement
//      filter. The element's own content (text, controls) sits on the
//      normal layer and stays sharp; only the backdrop sample gets bent.
//   2. feDisplacementMap needs a displacement map: R = 128 + dx,
//      B = 128 + dy, neutral grey (128) = no displacement. We generate the
//      map at runtime on a 256×256 canvas — radial field, zero across the
//      interior, bending outward near the rim like a lens edge.
//   3. An edge-highlight ring (::after, mask-composite exclude) draws the
//      thin bright rim the refraction suggests.
//
// Chromium-only eye candy: other engines either ignore the SVG url()
// filter or paint it differently and degrade to plain frosted glass. The
// CSS gates the warp filter on html.gui-liquid-glass-ready (armed by
// ensureLiquidGlass AFTER the <svg> is in the DOM) because Chromium hides
// an element whose filter references a missing id — a failed injection
// must never blank a pane.

const FILTER_ID = "musepi-liquid-glass-displace";
const READY_CLASS = "gui-liquid-glass-ready";
const MAP_SIZE = 256;

/** Bend strength in px at the rim (map units; scaled again by the
 *  feDisplacementMap `scale` attribute in the injected filter). */
const RIM_BEND_PX = 14;
/** Displacement stays zero inside this normalized radius; the ramp to the
 *  rim starts beyond it, so the interior stays perfectly legible. */
const INTERIOR_RADIUS = 0.62;

let injected: boolean | null = null;

/** Render the displacement map to a data URL. Neutral grey everywhere
 *  except near the rim, where the value bends outward along the radial
 *  direction (feDisplacementMap maps R/B − 128 onto ±scale). */
function displacementMapDataUrl(): string | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = MAP_SIZE;
	canvas.height = MAP_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	const img = ctx.createImageData(MAP_SIZE, MAP_SIZE);
	const half = MAP_SIZE / 2;
	for (let y = 0; y < MAP_SIZE; y++) {
		for (let x = 0; x < MAP_SIZE; x++) {
			const nx = (x - half) / half;
			const ny = (y - half) / half;
			const dist = Math.hypot(nx, ny);
			// t = 0 inside the interior, 1 at the corner (dist = √2).
			const t = Math.max(0, (dist - INTERIOR_RADIUS) / (Math.SQRT2 - INTERIOR_RADIUS));
			// t² easing: gentle onset, full strength only at the rim.
			const bend = t * t * RIM_BEND_PX;
			const ux = dist > 0 ? nx / dist : 0;
			const uy = dist > 0 ? ny / dist : 0;
			const i = (y * MAP_SIZE + x) * 4;
			img.data[i] = 128 + Math.round(ux * bend);
			img.data[i + 1] = 128;
			img.data[i + 2] = 128 + Math.round(uy * bend);
			img.data[i + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	return canvas.toDataURL("image/png");
}

/** Inject the SVG displacement filter and arm the CSS. Idempotent; returns
 *  false (and leaves the panes as plain frosted glass) when the map cannot
 *  be generated or the document is unavailable. */
export function ensureLiquidGlass(): boolean {
	if (injected !== null) return injected;
	injected = false;
	if (typeof document === "undefined") return false;
	const mapUrl = displacementMapDataUrl();
	if (!mapUrl) return false;

	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("width", "0");
	svg.setAttribute("height", "0");
	svg.setAttribute("aria-hidden", "true");
	svg.style.position = "absolute";

	const filter = document.createElementNS(svgNS, "filter");
	filter.setAttribute("id", FILTER_ID);
	// Overscan so the rim bend can sample backdrop outside the border box
	// instead of clipping at the edge.
	filter.setAttribute("x", "-20%");
	filter.setAttribute("y", "-20%");
	filter.setAttribute("width", "140%");
	filter.setAttribute("height", "140%");
	filter.setAttribute("color-interpolation-filters", "sRGB");

	const map = document.createElementNS(svgNS, "feImage");
	map.setAttribute("href", mapUrl);
	// No x/y/width/height: the primitive region fills the whole overscanned
	// filter region, and slice keeps the rim circular on non-square panes.
	map.setAttribute("preserveAspectRatio", "xMidYMid slice");
	map.setAttribute("result", "map");

	const displace = document.createElementNS(svgNS, "feDisplacementMap");
	displace.setAttribute("in", "SourceGraphic");
	displace.setAttribute("in2", "map");
	displace.setAttribute("scale", "24");
	displace.setAttribute("xChannelSelector", "R");
	displace.setAttribute("yChannelSelector", "B");

	filter.append(map, displace);
	svg.appendChild(filter);
	document.body.appendChild(svg);
	document.documentElement.classList.add(READY_CLASS);
	injected = true;
	return true;
}
