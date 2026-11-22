import { EXTENSION_SLOT_DECLARATION } from "@musepi/collab-proto/extension-slots";

/** A declared seat id. The value stays a plain string: the daemon and the
 *  compiled-plugin bridge exchange ids, not objects. */
export type SlotId = string;

/**
 * Validate a seat id against the declaration authority.
 *
 * The declaration is owned by `@musepi/collab-proto/extension-slots`; this
 * helper exists so a capability package can name its own seats without
 * restating the table. A name missing from the table throws at module load,
 * which is where a typo should surface.
 */
export function defineSlot(name: string): SlotId {
	if (!Object.hasOwn(EXTENSION_SLOT_DECLARATION.exact, name)) {
		throw new Error(`Unknown extension slot: ${name}`);
	}
	return name;
}
