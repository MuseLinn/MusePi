import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/**
 * Message color function that may also drive a separate animation loop.
 * When `animated` is true, the Loader runs a 30fps redraw so time-based
 * effects (shimmer, sweep) update smoothly even when the spinner frame
 * hasn't changed.
 */
export interface LoaderMessageColorFn {
	(text: string): string;
	/** When true, the loader runs a separate ~33ms animation loop. */
	animated?: boolean;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
const ANIMATED_FPS = 30;
const ANIMATED_INTERVAL_MS = Math.round(1000 / ANIMATED_FPS);

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private animatedIntervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: LoaderMessageColorFn;
	private message: string = "Loading...";

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: LoaderMessageColorFn,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.stopAnimatedLoop();
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
		this.start();
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) {
			// Still start the animated loop if the message function is animated
			this.startAnimatedLoop();
			return;
		}
		this.startAnimatedLoop();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, this.intervalMs);
	}

	private startAnimatedLoop(): void {
		if (this.messageColorFn.animated && !this.animatedIntervalId) {
			this.animatedIntervalId = setInterval(() => {
				this.updateDisplay();
			}, ANIMATED_INTERVAL_MS);
		}
	}

	private stopAnimatedLoop(): void {
		if (this.animatedIntervalId) {
			clearInterval(this.animatedIntervalId);
			this.animatedIntervalId = null;
		}
	}

	private updateDisplay(): void {
		const frame = this.frames[this.currentFrame] ?? "";
		const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
		const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
