import { useEffect, useState } from "react";
import { isMobileSurface, subscribeSurfaceChange } from "./surface.js";

/**
 * React view of `isMobileSurface()`, re-read on rotation, folding, window
 * resize and pointer-capability changes.
 *
 * A plain `isMobileSurface()` call at render time is enough for a one-shot
 * decision, but every consumer that branches on it also renders different DOM
 * after a fold or a window drag, so they need the re-render. Reading through
 * the state initialiser keeps the first paint correct without an effect pass.
 */
export function useMobileSurface(): boolean {
	const [mobile, setMobile] = useState(isMobileSurface);
	useEffect(() => {
		const sync = (): void => setMobile(isMobileSurface());
		sync();
		return subscribeSurfaceChange(sync);
	}, []);
	return mobile;
}
