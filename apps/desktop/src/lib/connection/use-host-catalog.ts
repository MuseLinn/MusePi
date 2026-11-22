/**
 * The one host catalog read, shared by both surfaces.
 *
 * `~/.ssh/config` and MusePi's `ssh.json` are read once per window and handed
 * to the instance form and the workspace wizard alike. Two independent loads
 * would be two answers to one question — and the earlier shape of this code
 * read the catalog in the wizard only, so the instance form's picker rendered
 * with an empty list and the whole feature was dead in the shipped shell while
 * its tests passed on an injected prop.
 *
 * Reading is renderer-safe: it goes through the shell bridge, so without one
 * (a browser build, or a test that did not inject) the catalog is empty and
 * every surface keeps its manual form.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { type CatalogHost, loadHostCatalog } from "./remote-lifecycle";

/**
 * The catalog for this window.
 *
 * `refresh` exists because the files can change under a long-lived window —
 * the user edits `~/.ssh/config`, then opens the manager — and a stale list
 * would offer hosts that no longer exist. Surfaces call it when they open.
 *
 * `refresh` is memoized, and that is a contract rather than a micro-
 * optimisation: "call it when the surface opens" reads naturally as
 * `useEffect(() => { if (open) refresh(); }, [open, refresh])`, and with a
 * function rebuilt each render that effect re-fires on every render — bumping
 * the nonce, re-reading the catalog, re-rendering, forever. A stable identity
 * is what makes the shape the doc comment invites safe to write. The guard in
 * `test/use-host-catalog-identity.test.tsx` fails if the identity ever becomes
 * per-render again.
 */
export function useHostCatalog(): { catalog: CatalogHost[]; refresh: () => void } {
	const [catalog, setCatalog] = useState<CatalogHost[]>([]);
	const [nonce, setNonce] = useState(0);
	const refresh = useCallback(() => setNonce(value => value + 1), []);

	useEffect(() => {
		let cancelled = false;
		void loadHostCatalog().then(
			rows => {
				if (!cancelled) setCatalog(rows);
			},
			() => {
				// A failed read is an empty catalog: the manual forms still work.
				if (!cancelled) setCatalog([]);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [nonce]);

	return useMemo(() => ({ catalog, refresh }), [catalog, refresh]);
}
