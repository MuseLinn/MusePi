/**
 * Compile-time contract for the desktop session's TypeScript surface.
 *
 * `native/index.d.ts` is generated from the crate's `#[napi]` items, so a
 * member the host relies on that goes missing or changes shape fails this
 * file's type check instead of a call site at runtime. Holds no runtime code
 * and is never executed: `bun test` matches only `.test.`/`.spec.` names.
 */
import {
	type CaptureRegion,
	type DesktopCapture,
	type DesktopControlState,
	type DesktopSession,
	type DesktopSessionOptions,
	desktopEscapeStops,
	forgetDesktopEscapeStops,
} from "../native/index.js";

export function desktopSessionTypeCheck(session: DesktopSession): void {
	const options: DesktopSessionOptions = { display: "1", escapeStopKey: "run-1" };
	void options.display;
	void options.escapeStopKey;

	const region: CaptureRegion = { x: 0, y: 0, width: 100, height: 50 };
	const zoom: Promise<DesktopCapture> = session.captureRegion("desktop", region);
	void zoom.then(capture => {
		const width: number = capture.coordinateWidth;
		const height: number = capture.coordinateHeight;
		const requested: CaptureRegion | undefined = capture.region;
		void [width, height, requested];
	});

	session.cancel();
	const stops: number = session.escapeStops;
	void stops;

	void session.acquireControl().then((state: DesktopControlState) => {
		const active: boolean = state.active;
		void active;
	});
	session.releaseControl();
	const state: DesktopControlState = session.controlState();
	void state.active;
	session.retire();
	session.setRunDeadline(30_000);

	const counted: number = desktopEscapeStops("run-1");
	void counted;
	forgetDesktopEscapeStops("run-1");
}
