package com.musepi.mobile;

import android.view.WindowInsets;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes the real system-bar insets (status bar top, navigation bar bottom,
 * cutout sides) to the web layer. Android WebView does not surface these via
 * env(safe-area-inset-*) even in edge-to-edge mode, so the app reads them
 * here and injects the CSS variables (--safe-top / --safe-bottom / --safe-left
 * / --safe-right) instead. Values are returned in dp.
 *
 * Types come from WindowInsetsCompat, not WindowInsets.Type: the platform
 * class only exists from API 30 while minSdk is 24, and a missing class is an
 * Error that the bridge's `catch (Exception)` never sees — every call on
 * Android 7–10 would have taken the WebView down. androidx back-fills the same
 * type masks from the system-window insets on those releases.
 */
@CapacitorPlugin(name = "Insets")
public class InsetsPlugin extends Plugin {
	@PluginMethod
	public void getSystemBars(PluginCall call) {
		JSObject ret = new JSObject();
		int top = 0;
		int bottom = 0;
		int left = 0;
		int right = 0;
		try {
			WindowInsets insets = getActivity().getWindow().getDecorView().getRootWindowInsets();
			if (insets != null) {
				WindowInsetsCompat compat = WindowInsetsCompat.toWindowInsetsCompat(insets);
				Insets bars = compat.getInsets(WindowInsetsCompat.Type.systemBars());
				// A landscape cutout sits on the side and a foldable's hinge can
				// push content away from either edge; status/navigation bars alone
				// report 0 there. Max keeps the pair additive rather than letting a
				// zero from one source erase the other.
				Insets cutout = compat.getInsets(WindowInsetsCompat.Type.displayCutout());
				top = bars.top;
				bottom = bars.bottom;
				left = Math.max(bars.left, cutout.left);
				right = Math.max(bars.right, cutout.right);
			}
			float density = getActivity().getResources().getDisplayMetrics().density;
			ret.put("top", Math.round(top / density));
			ret.put("bottom", Math.round(bottom / density));
			ret.put("left", Math.round(left / density));
			ret.put("right", Math.round(right / density));
		} catch (Exception e) {
			ret.put("top", 0);
			ret.put("bottom", 0);
			ret.put("left", 0);
			ret.put("right", 0);
		}
		call.resolve(ret);
	}

	/**
	 * Physical display metrics for text-scale normalisation.
	 *
	 * A CSS px in the WebView is one dp, and one dp is a fixed fraction of an
	 * inch only on the density the design was tuned on. A 460 ppi phone and a
	 * 415 ppi tablet therefore render the same 15px at visibly different
	 * physical sizes. The web layer turns `xdpi / density` into a factor
	 * relative to the reference logical density, clamped, and applies it to
	 * text only — this method is the only place those two numbers exist.
	 */
	@PluginMethod
	public void getDisplayMetrics(PluginCall call) {
		JSObject ret = new JSObject();
		try {
			android.util.DisplayMetrics metrics = getActivity().getResources().getDisplayMetrics();
			ret.put("xdpi", metrics.xdpi);
			ret.put("ydpi", metrics.ydpi);
			ret.put("density", metrics.density);
			ret.put("densityDpi", metrics.densityDpi);
		} catch (Exception e) {
			ret.put("xdpi", 0);
			ret.put("ydpi", 0);
			ret.put("density", 0);
			ret.put("densityDpi", 0);
		}
		call.resolve(ret);
	}
}
