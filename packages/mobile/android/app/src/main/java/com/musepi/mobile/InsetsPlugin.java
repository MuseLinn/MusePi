package com.musepi.mobile;

import android.view.WindowInsets;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes the real system-bar insets (status bar top, navigation bar bottom)
 * to the web layer. Android WebView does not surface these via
 * env(safe-area-inset-*) even in edge-to-edge mode, so the app reads them
 * here and injects the CSS variables (--safe-top / --safe-bottom) instead.
 * Values are returned in dp.
 */
@CapacitorPlugin(name = "Insets")
public class InsetsPlugin extends Plugin {
	@PluginMethod
	public void getSystemBars(PluginCall call) {
		JSObject ret = new JSObject();
		try {
			WindowInsets insets = getActivity().getWindow().getDecorView().getRootWindowInsets();
			float density = getActivity().getResources().getDisplayMetrics().density;
			int top = 0;
			int bottom = 0;
			if (insets != null) {
				top = insets.getInsets(WindowInsets.Type.statusBars()).top;
				bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
			}
			ret.put("top", Math.round(top / density));
			ret.put("bottom", Math.round(bottom / density));
		} catch (Exception e) {
			ret.put("top", 0);
			ret.put("bottom", 0);
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