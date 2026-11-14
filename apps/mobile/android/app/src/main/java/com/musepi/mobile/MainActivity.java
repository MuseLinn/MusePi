package com.musepi.mobile;

import android.os.Bundle;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		// registerPlugin() only appends to bridgeBuilder — the bridge is
		// built (and plugins loaded) inside super.onCreate(), so the custom
		// Insets plugin must be queued BEFORE the super call.
		registerPlugin(InsetsPlugin.class);
		super.onCreate(savedInstanceState);
		// True edge-to-edge: the WebView paints under the transparent status
		// and gesture-navigation bars; the web UI offsets itself via the
		// Insets plugin (Android WebView ignores env(safe-area-inset-*)).
		WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
		// Consume every inset type at the decor so the WebView is laid out in
		// the full window (content bleeds behind the status and nav bars).
		// IME insets are deliberately included too — the Capacitor keyboard
		// plugin and CSS visualViewport handling manage keyboard offsets.
		ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (v, insets) ->
			WindowInsetsCompat.CONSUMED);
	}

	// The Android 12+ SplashScreen (core-splashscreen) drives the window
	// through the launch transition and may restore decor-fit after onCreate.
	// Re-assert edge-to-edge once the window gains focus (post-transition) so
	// the WebView reliably bleeds under the system bars.
	@Override
	public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		if (hasFocus) {
			WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
		}
	}
}