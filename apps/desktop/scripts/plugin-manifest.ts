/**
 * Slot declarations lifted from a plugin's entry module at build time.
 *
 * The daemon assembles every surface from the build manifest instead of mounting
 * each plugin's cordis fiber at boot, so a declaration that never reaches the
 * manifest is a surface that silently never mounts. Both halves below exist to
 * keep that from being a matter of care:
 *
 * - a register call declares more than its slot (order, availability), and a
 *   dropped field changes behaviour rather than presentation — an `on-demand`
 *   tab becomes a permanent rail entry;
 * - one plugin owns several surfaces, so declarations accumulate per entry
 *   module instead of replacing each other.
 */

export interface DeclaredSlot {
	slot: string;
	moduleUrl: string;
	label?: string;
	order?: number;
	availability?: string;
}

/** The manifest row a declaration compiles down to. */
export interface ManifestDeclaration {
	slot: string;
	file: string;
	css?: string;
	label?: string;
	order?: number;
	availability?: string;
}

/** Every `register({...})` in a plugin entry module, read from its source.
 *
 *  A register call is a literal object, so its fields can be lifted without
 *  evaluating the module. A plugin that computes its slot at runtime simply
 *  yields no row here and keeps the daemon's load path. */
export function parseDeclaredSlots(source: string): DeclaredSlot[] {
	const rows: DeclaredSlot[] = [];
	for (const match of source.matchAll(/register\(\{([^}]*)\}\)/g)) {
		const body = match[1] ?? "";
		const slot = /slot:\s*"([^"]+)"/.exec(body)?.[1];
		const moduleUrl = /moduleUrl:\s*"\.\/([^"]+)"/.exec(body)?.[1];
		if (slot === undefined || moduleUrl === undefined) continue;
		const label = /label:\s*"([^"]+)"/.exec(body)?.[1];
		const order = /order:\s*(-?\d+)/.exec(body)?.[1];
		const availability = /availability:\s*"([^"]+)"/.exec(body)?.[1];
		rows.push({
			slot,
			moduleUrl: `./${moduleUrl}`,
			...(label ? { label } : {}),
			...(order ? { order: Number(order) } : {}),
			...(availability ? { availability } : {}),
		});
	}
	return rows;
}

/** Append the declarations one compiled surface contributes to its entry module.
 *
 *  Accumulating is the whole point: the caller visits a plugin once per surface,
 *  and replacing the array would keep only the last surface compiled — the
 *  earlier ones vanish from the manifest and never mount. */
export function mergeDeclarations(
	existing: readonly ManifestDeclaration[] | undefined,
	declared: readonly DeclaredSlot[],
	surface: { relative: string; file: string; css?: string },
): ManifestDeclaration[] {
	return [
		...(existing ?? []),
		...declared
			.filter(row => row.moduleUrl === `./${surface.relative}`)
			.map(row => ({
				slot: row.slot,
				file: surface.file,
				...(surface.css ? { css: surface.css } : {}),
				...(row.label ? { label: row.label } : {}),
				...(row.order !== undefined ? { order: row.order } : {}),
				...(row.availability ? { availability: row.availability } : {}),
			})),
	];
}
