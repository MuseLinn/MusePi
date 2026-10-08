/**
 * Exclusive-mount declaration: one package, at most one live mount.
 *
 * Some plugins own a global name — a route prefix, a window class, a process on
 * a fixed port. Mounting two of them does not degrade, it collides: the second
 * registration either throws at boot or, worse, silently shadows the first and
 * leaves two half-live copies. An aggregate bundle that re-declares a plugin
 * another bundle already mounts is the ordinary way that happens.
 *
 * The declaration is what lets a package say so without evaluating anything.
 * The upstream form of this guard is a `!!js` expression that reads the loader's
 * own row table at mount time — which this host deliberately does not run, and
 * which a sandbox for expression evaluation would not admit anyway, since it
 * reaches into live runtime state rather than computing from data.
 *
 * So it is declared instead: a package says its mount is exclusive, and the
 * loader declines the second one and says which entry already holds it.
 */
import { type PluginBlock, type PluginPackageJson, readPluginBlock } from "./manifest-block";

/** What a package declares about how it may be mounted. */
export interface PluginMountDeclaration {
	/**
	 * Whether a second mount of this package must be declined.
	 *
	 * Default false. A package with no global footprint can be mounted twice
	 * harmlessly, and refusing it would break aggregate bundles for nothing.
	 */
	readonly exclusive: boolean;
	/**
	 * The globally-owned name, when the package knows it.
	 *
	 * Only used in the refusal message — a person deciding whether to remove a
	 * duplicate needs to see what the two mounts are fighting over, and that is
	 * the package's to say, not the loader's to guess.
	 */
	readonly owns?: string;
}

/**
 * Read a package's mount declaration.
 *
 * Absent, malformed, or non-boolean means "not exclusive": the default is the
 * permissive one, so a typo in a field nothing depends on cannot silently
 * disable a plugin.
 */
export function readMountDeclaration(pkg: PluginPackageJson | null | undefined): PluginMountDeclaration {
	const block: PluginBlock | undefined = readPluginBlock(pkg);
	const mount = block?.mount;
	if (mount === null || typeof mount !== "object") return { exclusive: false };
	const record = mount as Record<string, unknown>;
	const owns = typeof record.owns === "string" ? record.owns : undefined;
	return {
		exclusive: record.exclusive === true,
		...(owns === undefined ? {} : { owns }),
	};
}

/** Why a mount was declined. */
export type MountRefusal =
	| { readonly refused: false }
	| {
			readonly refused: true;
			/** Entry id of the mount already holding it. */
			readonly heldBy: string;
			/** Package behind that entry, when it differs from the incoming one. */
			readonly heldByName?: string;
			/** The globally-owned name, when the package declared one. */
			readonly owns?: string;
	  };

/**
 * Decide whether one package may be mounted, given what is already mounted.
 *
 * The collision is between two *entries*, never between a package and itself:
 * one package mounted under two ids is exactly the case that has to be caught,
 * because both halves register the same global name. So only the same entry id is
 * exempt, and that exemption is what lets a reload of one entry — which re-runs
 * this — proceed instead of refusing itself.
 *
 * @param incomingId - the entry id this mount would register under.
 * @param incomingName - the package this mount belongs to.
 * @param declaration - the incoming package's own declaration.
 * @param mounted - what is already live, as entry id → the package name holding it.
 *   Keyed by id rather than by name because a name-keyed lookup cannot see two
 *   ids holding one package, which is the case this exists for.
 */
export function decideMount(
	incomingId: string,
	incomingName: string,
	declaration: PluginMountDeclaration,
	mounted: ReadonlyMap<string, string>,
): MountRefusal {
	if (!declaration.exclusive) return { refused: false };
	for (const [id, heldByName] of mounted) {
		if (id === incomingId) continue;
		return {
			refused: true,
			heldBy: id,
			// Named only when it differs: "already mounted" is noise when the two
			// are the same package, and the whole story when they are not.
			...(heldByName === undefined || heldByName === incomingName ? {} : { heldByName }),
			...(declaration.owns === undefined ? {} : { owns: declaration.owns }),
		};
	}
	return { refused: false };
}
