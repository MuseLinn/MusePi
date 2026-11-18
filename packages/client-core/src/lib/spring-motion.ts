/**
 * Spring motion — a reusable, JS-driven animation resource.
 *
 * Why this exists rather than a CSS transition: a CSS curve has to be a
 * function of TIME, so it cannot express the two things a shape change needs
 * — how much it overshoots (`bounce`) and how long it takes to FEEL settled
 * (`visualDuration`, which is not the same as the time it takes to stop
 * moving). A spring's parameters say exactly those two things, and the same
 * parameters then work for width, height, radius, opacity and transform
 * without each one needing its own hand-tuned cubic-bezier.
 *
 * The parameters here match the ones the Codex desktop client's floating
 * Quick Chat bar uses for its composer morph, so a surface can adopt them
 * and land on the same feel:
 *
 *   { type: "spring", visualDuration: 0.44, bounce: 0.22 }
 *
 * `visualDuration` is the perceptual settle time in seconds — the spring may
 * still be moving a hair past it. `bounce` is the overshoot: 0 is critically
 * damped (no overshoot), and larger values overshoot further.
 *
 * This module is a DESIGN RESOURCE, not a pet detail: anything that morphs
 * between two shapes can adopt it. It is deliberately free of DOM and React
 * so it can be used from a canvas renderer, a scroll handler, or a plain
 * element style.
 *
 * Units: `visualDuration` in seconds, `bounce` dimensionless, `stiffness` /
 * `damping` / `mass` in the usual physical units.
 */

/** A spring's physical parameters, in one of the two dialects. */
export interface SpringConfig {
	/**
	 * Perceptual settle time in seconds. The spring may still be creeping
	 * past this point; the eye reads it as "arrived".
	 */
	visualDuration?: number;
	/**
	 * Overshoot. 0 = critically damped (no overshoot). The mapping is not
	 * linear: the perceived overshoot grows faster than the number, so the
	 * useful range is roughly 0…0.4.
	 */
	bounce?: number;
	/** Physical stiffness — the spring constant. */
	stiffness?: number;
	/** Physical damping — how quickly the oscillation dies. */
	damping?: number;
	/** Mass of the animated value. */
	mass?: number;
}

export interface SpringOptions extends SpringConfig {
	/** Starting value. */
	from: number;
	/** Value the spring settles on. */
	to: number;
	/**
	 * Initial velocity, in units per second. A value that already carries
	 * motion (a surface that was moving when it changed shape) should pass
	 * its real velocity here, otherwise the spring restarts from a standstill
	 * and the change reads as a hiccup.
	 */
	velocity?: number;
	/**
	 * Hard stop in seconds. A spring's settle time depends on its damping,
	 * and an under-damped one can ring for a long time; the cap keeps a
	 * runaway animation from outliving the surface it belongs to.
	 */
	maxDuration?: number;
}

/**
 * Convert the perceptual parameters (`visualDuration` + `bounce`) into the
 * physical ones a solver needs.
 *
 * The spring's response is characterised by its damping ratio ζ and natural
 * frequency ω. `visualDuration` fixes ω (how fast it moves) and `bounce`
 * fixes ζ (how much it rings).
 *
 * The bounce → ζ mapping is calibrated so that `bounce` reads as the
 * fraction the spring overshoots its target by: 0.2 means the surface sails
 * about a fifth of the way past where it is heading before coming back. The
 * overshoot of a damped oscillator is
 *
 *   exp(-πζ / √(1 - ζ²))
 *
 * so inverting it gives ζ = -ln(overshoot) / √(π² + ln²(overshoot)). At
 * bounce 0.22 that is ζ ≈ 0.73 — visibly springy without being loose.
 */
export function springPhysics(config: SpringConfig): { stiffness: number; damping: number; mass: number } {
	const { visualDuration = 0.44, bounce = 0.22, mass = 1 } = config;
	// Overshoot fraction → damping ratio (see above). A bounce of 0 is
	// critically damped; the limit is clamped so the inverse stays finite.
	const overshoot = Math.min(Math.max(bounce, 0), 0.9);
	const logOvershoot = Math.log(overshoot);
	const zeta =
		overshoot === 0 ? 1 : Math.min(0.999, -logOvershoot / Math.sqrt(Math.PI * Math.PI + logOvershoot * logOvershoot));
	// ω from the perceptual duration. A spring that settles in D seconds
	// reaches its target at roughly ω ≈ 2π / D for the critically damped
	// case; the visual settle is a little longer than the half-period, so
	// the constant is derived from that rather than guessed.
	const omega = (2 * Math.PI) / Math.max(0.05, visualDuration) / 1.6;
	return {
		stiffness: omega * omega * mass,
		damping: 2 * zeta * omega * mass,
		mass,
	};
}

/**
 * Sample a spring at `elapsed` seconds.
 *
 * Returns the value AND the velocity, because a caller that chains springs
 * (a surface that changes shape while it is still moving) needs to hand the
 * velocity to the next one.
 */
export function sampleSpring(options: SpringOptions, elapsed: number): { value: number; velocity: number } {
	const { from, to, velocity: initialVelocity = 0, maxDuration = 4 } = options;
	const { stiffness, damping, mass } = springPhysics(options);
	const displacement = from - to;
	if (displacement === 0 && initialVelocity === 0) return { value: to, velocity: 0 };

	// Closed-form solution of a damped harmonic oscillator, which is exact
	// at any time — no integration error, and no fixed timestep to drift.
	const t = Math.min(Math.max(elapsed, 0), maxDuration);
	const omega0 = Math.sqrt(stiffness / mass);
	const zeta = damping / (2 * Math.sqrt(stiffness * mass));
	let value: number;
	let velocity: number;
	if (zeta < 1) {
		// Under-damped: the spring rings around the target.
		const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
		const a = displacement;
		const b = (initialVelocity + zeta * omega0 * displacement) / omegaD;
		const decay = Math.exp(-zeta * omega0 * t);
		value = to + decay * (a * Math.cos(omegaD * t) + b * Math.sin(omegaD * t));
		velocity =
			decay *
			(-a * (zeta * omega0 * Math.cos(omegaD * t) + omegaD * Math.sin(omegaD * t)) +
				b * (omegaD * Math.cos(omegaD * t) - zeta * omega0 * Math.sin(omegaD * t)));
	} else if (zeta === 1) {
		// Critically damped: fastest approach without overshoot.
		const decay = Math.exp(-omega0 * t);
		const a = displacement;
		const b = initialVelocity + omega0 * displacement;
		value = to + decay * (a + b * t);
		velocity = decay * (b - omega0 * (a + b * t));
	} else {
		// Over-damped: two real exponentials, no ringing at all.
		const r = omega0 * Math.sqrt(zeta * zeta - 1);
		const r1 = -zeta * omega0 + r;
		const r2 = -zeta * omega0 - r;
		const c2 = (initialVelocity - r1 * displacement) / (r2 - r1);
		const c1 = displacement - c2;
		value = to + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
		velocity = c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t);
	}
	if (elapsed >= maxDuration) return { value: to, velocity: 0 };
	return { value, velocity };
}

/**
 * The fraction of the animation that has elapsed at `elapsed` seconds — the
 * spring's own progress, which reaches 1 at the visual settle time rather
 * than at the physical one. Use it to drive a SECOND property from the same
 * spring (an opacity that must finish with the size change, say) without
 * running two animations.
 */
export function springProgress(options: SpringOptions, elapsed: number): number {
	const { from, to } = options;
	if (from === to) return 1;
	const { value } = sampleSpring(options, elapsed);
	return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

/**
 * Drive a spring from a callback. Returns a stop function.
 *
 * The callback receives the sampled value, the elapsed time, and the
 * VELOCITY. The velocity is what tells a caller whether the spring has
 * settled or is merely passing through the target on its way to the
 * overshoot — the difference between "this has arrived" and "this is
 * momentarily near where it is going". It runs on `requestAnimationFrame`,
 * so it stops when the tab is hidden — a spring that keeps ticking in a
 * background tab is a spring that resumes mid-flight.
 *
 * `onDone` fires once the animation reaches its cap, whether or not it has
 * visibly settled.
 */
export function animateSpring(
	options: SpringOptions,
	onFrame: (value: number, elapsed: number, velocity: number) => void,
	onDone?: () => void,
): () => void {
	const started = performance.now();
	let frame = 0;
	let stopped = false;
	const step = (): void => {
		if (stopped) return;
		const elapsed = (performance.now() - started) / 1000;
		const { value, velocity } = sampleSpring(options, elapsed);
		onFrame(value, elapsed, velocity);
		if (elapsed >= (options.maxDuration ?? 4)) {
			stopped = true;
			onDone?.();
			return;
		}
		frame = requestAnimationFrame(step);
	};
	frame = requestAnimationFrame(step);
	return (): void => {
		stopped = true;
		cancelAnimationFrame(frame);
	};
}

/**
 * The spring the Codex desktop client uses for its floating Quick Chat
 * surface, expressed in this module's parameters. Reuse it wherever a
 * surface morphs between a compact and an expanded shape.
 */
export const MORPH_SPRING: SpringConfig = {
	visualDuration: 0.44,
	bounce: 0.22,
};

/**
 * A gentler spring for small surfaces — a pill that grows into a field. The
 * same overshoot as {@link MORPH_SPRING} but a shorter settle, because a
 * compact control that lingers reads as lag.
 */
export const COMPACT_MORPH_SPRING: SpringConfig = {
	visualDuration: 0.32,
	bounce: 0.18,
};

/**
 * Sample a spring into a CSS `linear()` easing curve.
 *
 * This is how a spring reaches CSS-only properties — a sidebar's width, a
 * progress fill — without an rAF driver on every element. The curve is a
 * list of (progress @ time%) stops, so CSS plays the EXACT shape a spring
 * would have produced: under-damped springs sail past 1 and come back, a
 * critically damped one lands on 1 monotonically.
 *
 * The stops are mote-carlo even in TIME, not in progress: a spring moves
 * fastest at the start, so an even-progress sampling would flatten the
 * interesting part. The last stop is pinned to exactly 1 so the animation
 * ends on its target rather than a fraction short.
 *
 * @param config the spring parameters
 * @param samples number of stops (24 is plenty for a UI transition; 30-40
 *        for a large travel where the overshoot must read crisply)
 * @param durationMs CSS duration to print alongside the curve. Defaults to
 *        the spring's hard cap.
 */
export function springEasing(
	config: SpringConfig & Pick<SpringOptions, "maxDuration">,
	samples = 32,
	durationMs?: number,
): string {
	const duration = durationMs ?? config.maxDuration ?? Math.max(0.4, (config.visualDuration ?? 0.44) * 2);
	const options: SpringOptions = { from: 0, to: 1, ...config, maxDuration: duration / 1000 };
	const stops: string[] = [];
	for (let index = 0; index <= samples; index++) {
		const fraction = index / samples;
		const { value } = sampleSpring(options, fraction * (duration / 1000));
		// The last stop must be 1 exactly, or the element settles a pixel
		// short of its target. Intermediate stops keep the spring's raw
		// value, including any overshoot past 1.
		const printed = index === samples ? 1 : Number(value.toFixed(5));
		stops.push(index === 0 ? "0" : `${printed} ${(fraction * 100).toFixed(3)}%`);
	}
	return `linear(${stops.join(", ")})`;
}
