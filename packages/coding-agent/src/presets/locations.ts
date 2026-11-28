import * as os from "node:os";
import { join } from "node:path";

/**
 * Where preset files live: `~/.musepi/presets`.
 *
 * The directory used to be `~/.musepi/modes`, which read as the approval mode
 * (`tools.approvalMode`) even though it only ever held agent presets. There is
 * one directory now — no fallback read of the old one: a second location would
 * make "which file wins" ambiguous, and the same id could be shadowed by a
 * stale copy.
 *
 * `MUSEPI_MODES_DIR` keeps its name because harnesses isolate through it; an
 * explicit override is not the guessable default this rename was about.
 */

/** Directory preset files are read from and written to. */
export function presetsDir(home: string = os.homedir()): string {
	return process.env.MUSEPI_MODES_DIR ?? join(home, ".musepi", "presets");
}
