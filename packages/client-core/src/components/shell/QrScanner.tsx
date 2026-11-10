import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { isHarmonyShell } from "../../lib/capacitor";
import { haptic } from "../../lib/haptics";

export interface QrScannerProps {
	onCancel: () => void;
	onResult: (link: string) => void;
}

/**
 * Full-screen QR scanner for the connect guide. Uses getUserMedia + jsQR
 * (pure-JS decoding) instead of @capacitor-mlkit — that plugin requires the
 * Google Play Services barcode module, which is unavailable on 卓易通 /
 * HarmonyOS-compat layers and non-GMS devices. The overlay is a designed
 * camera finder: dimmed mask, glowing corner brackets, a sweeping scan line,
 * torch toggle and a close affordance.
 */
export function QrScanner({ onCancel, onResult }: QrScannerProps): React.JSX.Element {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [torch, setTorch] = useState(false);
	const [found, setFound] = useState(false);
	const [facing, setFacing] = useState<"environment" | "user">("environment");
	const [hasMultiCam, setHasMultiCam] = useState(false);
	/** Camera permission was refused — HarmonyOS will not re-prompt by itself. */
	const [permissionDenied, setPermissionDenied] = useState(false);

	// Full-screen camera overlay. On HarmonyOS the native bar floats ABOVE the
	// web view, so it would sit on the viewfinder and its light material would
	// glow through the black mask. Hide it for the scanner's lifetime.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		try {
			window.harmonyNative?.setTabBarVisible?.(false);
		} catch {
			// bridge missing — nothing to hide
		}
		return () => {
			try {
				window.harmonyNative?.setTabBarVisible?.(true);
			} catch {
				// bridge missing
			}
		};
	}, []);

	useEffect(() => {
		let alive = true;
		let raf = 0;
		let stream: MediaStream | null = null;
		let lastDecode = 0;
		// The overlay keeps painting for the 380 ms success flash. Without this
		// latch every frame in that window re-decoded the same code and
		// scheduled its own `onResult` — four or five connect attempts, each
		// building a fresh GuestClient, from one scan.
		let accepted = false;
		const video = videoRef.current;
		const canvas = canvasRef.current;
		if (!video || !canvas) return;

		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;

		const tick = (): void => {
			if (!alive) return;
			raf = requestAnimationFrame(tick);
			if (accepted) return;
			if (video.readyState < 2 || video.videoWidth === 0) return;
			const w = video.videoWidth;
			const h = video.videoHeight;
			if (canvas.width !== w) canvas.width = w;
			if (canvas.height !== h) canvas.height = h;
			ctx.drawImage(video, 0, 0, w, h);
			const now = performance.now();
			if (now - lastDecode > 120) {
				lastDecode = now;
				try {
					const image = ctx.getImageData(0, 0, w, h);
					const result = jsQR(image.data, w, h);
					if (result?.data) {
						const link = result.data.trim();
						if (link && !accepted) {
							accepted = true;
							setFound(true);
							haptic([10, 40, 10]);
							// brief success flash before closing the overlay
							window.setTimeout(() => onResult(link), 380);
						}
					}
				} catch {
					// decode error — keep scanning
				}
			}
		};

		const start = async (): Promise<void> => {
			try {
				// Secure-context guard: getUserMedia is undefined on opaque or
				// non-https origins. Distinguishing this from a permission denial
				// is the difference between "grant camera" and "fix the origin".
				if (!navigator.mediaDevices?.getUserMedia) {
					if (alive) setError(`${t("settings.cameraUnavailableUsePair")} · no mediaDevices (insecure context?)`);
					return;
				}
				// Re-entry (camera flip, foreground return) must not leave the
				// previous track alive: two live camera streams on one element
				// keeps the LED on and can wedge the sensor.
				stream?.getTracks().forEach(track => track.stop());
				stream = await navigator.mediaDevices.getUserMedia({
					video: {
						facingMode: { ideal: facing },
						// Ask for a sharp feed — QR decode quality on phones
						// collapses badly at 640×480 defaults.
						width: { ideal: 1920 },
						height: { ideal: 1080 },
					},
					audio: false,
				});
				if (!alive) {
					stream.getTracks().forEach(track => track.stop());
					return;
				}
				video.srcObject = stream;
				// Mirror only user-facing cameras (selfie convention). Rear
				// cameras (facingMode=environment) must NOT be mirrored — the
				// previous blanket scaleX(-1) flipped the rear feed.
				const settings = stream.getVideoTracks()[0]?.getSettings();
				const facingMode = settings?.facingMode;
				video.style.transform = facingMode === "user" ? "scaleX(-1)" : "none";
				await video.play();
				// Continuous autofocus: many Android WebViews default to a
				// fixed/one-shot focus that never re-racks on the QR code.
				// Apply post-start (some cameras only honour it once live);
				// unsupported cameras reject silently and keep their default.
				const track = stream.getVideoTracks()[0];
				const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
				if (caps?.focusMode?.includes("continuous")) {
					track
						.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] })
						.catch(() => {
							// focusMode unsupported — keep the camera default
						});
				}
				// Flip affordance only when the device actually has >1 camera.
				navigator.mediaDevices
					.enumerateDevices?.()
					.then(devices => {
						if (alive) setHasMultiCam(devices.filter(d => d.kind === "videoinput").length > 1);
					})
					.catch(() => {});
				raf = requestAnimationFrame(tick);
			} catch (err) {
				if (alive) {
					// Keep the user-facing copy clean; the browser's reason is only
					// needed to decide whether to offer the permission shortcut.
					setError(t("settings.cameraUnavailableUsePair"));
					if (err instanceof Error && err.name === "NotAllowedError") {
						setPermissionDenied(true);
					}
				}
			}
		};
		void start();

		// The camera is a device-wide resource: backgrounding the app must
		// release it, otherwise the LED stays lit and another app cannot open
		// it. Resuming re-acquires and restarts the decode loop.
		const onVisibility = (): void => {
			if (!alive) return;
			if (document.hidden) {
				cancelAnimationFrame(raf);
				stream?.getTracks().forEach(track => track.stop());
				stream = null;
				return;
			}
			if (accepted) return;
			lastDecode = 0;
			void start();
		};
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			alive = false;
			cancelAnimationFrame(raf);
			document.removeEventListener("visibilitychange", onVisibility);
			stream?.getTracks().forEach(track => track.stop());
		};
	}, [onResult, facing]);

	const flipCamera = (): void => {
		haptic(8);
		setTorch(false);
		setFacing(f => (f === "environment" ? "user" : "environment"));
	};

	const toggleTorch = (): void => {
		const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks()?.[0];
		if (!track) return;
		const next = !torch;
		// FCapabilities: applyConstraints may reject if torch unsupported.
		track
			.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
			.then(() => setTorch(next))
			.catch(() => {
				// torch unsupported — keep state off
			});
	};

	return (
		<div className="qr-overlay" role="dialog" aria-modal="true" aria-label={t("settings.scanQrCode")}>
			<video ref={videoRef} className="qr-video" playsInline muted autoPlay={false} />
			<canvas ref={canvasRef} className="qr-canvas" aria-hidden="true" />
			<div className="qr-shade" aria-hidden="true" />

			{/* Viewfinder */}
			<div className={`qr-frame${found ? " qr-frame--found" : ""}`} aria-hidden="true">
				<span className="qr-corner qr-corner--tl" />
				<span className="qr-corner qr-corner--tr" />
				<span className="qr-corner qr-corner--bl" />
				<span className="qr-corner qr-corner--br" />
				<span className="qr-scanline" />
			</div>

			<header className="qr-top">
				<button type="button" className="qr-close" onClick={onCancel} aria-label={t("settings.close")}>
					✕
				</button>
				<span className="qr-title">{t("settings.scanQrCode")}</span>
				<span className="qr-spacer" aria-hidden="true" />
			</header>

			<footer className="qr-bottom">
				{isHarmonyShell() && permissionDenied ? (
					// Denied once → HarmonyOS stops showing the dialog. Give the
					// user a way back into the system permission page.
					<button type="button" className="qr-grant" onClick={() => window.harmonyNative?.openCameraSettings?.()}>
						{t("settings.grantCameraAccess")}
					</button>
				) : (
					<button type="button" className="qr-torch" onClick={() => void toggleTorch()} aria-pressed={torch}>
						{torch ? "💡" : "🔦"} <span>{t("settings.torch")}</span>
					</button>
				)}
				{hasMultiCam && (
					<button type="button" className="qr-flip" onClick={flipCamera} aria-label={t("settings.switchCamera")}>
						🔄 <span>{t("settings.switchCamera")}</span>
					</button>
				)}
				<p className="qr-hint">{error ?? t("settings.alignQrCodeFrame")}</p>
			</footer>
		</div>
	);
}
