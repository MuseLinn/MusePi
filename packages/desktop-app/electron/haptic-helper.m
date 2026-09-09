/*
 * haptic-helper — minimal macOS Taptic Engine trigger for MusePi.
 *
 * Compiled once with clang (Xcode CLT, no extra runtime deps):
 *   clang -fobjc-arc -framework AppKit -framework Foundation -O2 \
 *         -o haptic-helper haptic-helper.m
 *
 * Persistent stdin daemon: reads one pattern per line (0 generic,
 * 1 alignment, 2 level-change), performs the tap, loops. Exits on EOF
 * (parent death closes the pipe). Spawned once by main.cjs so per-tap
 * latency is a stdin write (~µs) instead of a process spawn (~30ms).
 * NSHapticFeedbackManager no-ops on devices without a haptic trackpad —
 * that silent behavior is expected.
 *
 * Why not osascript/JXA (the previous implementation): the JXA ObjC bridge
 * does NOT expose NSTrackpadHapticFeedbackPerformer's instance methods —
 * both `performOutputPattern` (wrong selector, what the old code called)
 * and the real `performFeedbackPattern:performanceTime:` bridge as
 * undefined, so every tap threw and was swallowed. A compiled binary also
 * starts ~10× faster than osascript, and the persistent loop removes the
 * spawn cost entirely.
 */
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

int main(void) {
	@autoreleasepool {
		// defaultPerformer is id<NSHapticFeedbackPerformer> — the protocol
		// (not NSHapticFeedbackManager) declares performFeedbackPattern:.
		id<NSHapticFeedbackPerformer> performer = NSHapticFeedbackManager.defaultPerformer;
		char line[16];
		while (fgets(line, sizeof(line), stdin)) {
			@autoreleasepool {
				long n = strtol(line, NULL, 10);
				NSHapticFeedbackPattern pattern = NSHapticFeedbackPatternGeneric;
				if (n == 1) {
					pattern = NSHapticFeedbackPatternAlignment;
				} else if (n == 2) {
					pattern = NSHapticFeedbackPatternLevelChange;
				}
				[performer performFeedbackPattern:pattern
				                   performanceTime:NSHapticFeedbackPerformanceTimeNow];
			}
		}
	}
	return 0;
}
