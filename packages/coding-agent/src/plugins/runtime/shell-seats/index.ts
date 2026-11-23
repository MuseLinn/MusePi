/**
 * The seats the app shell renders for the whole process.
 *
 * A contributor targeting a core seat waits for somebody to declare it; the
 * shell's own components are not plugins, so nobody would. Declaring them here,
 * once per process, is what makes `ctx.slots.inject("settings.section", …)` run
 * immediately instead of queuing forever.
 *
 * The list comes from the slot contracts (`lifetime: "core"`), so it cannot
 * drift from the catalog the model reads.
 */
import { CORE_SEATS } from "@musepi/collab-proto/slot-contracts";
import { declareCoreSeats } from "@musepi/pi-coding-agent/extensibility/extensions/seat-lifecycle";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";

export const name = "musepi-shell-seats";
export const inject = [] as const;
export const provide = [] as const;

/** Declare the core seats for this process; they live until the host disposes. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(declareCoreSeats(CORE_SEATS), "shell-seats:core");
}
