import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { t } from "../../i18n/index.js";
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

	useEffect(() => {
		let alive = true;
		let raf = 0;
		let stream: MediaStream | null = null;
		let lastDecode = 0;
		const video = videoRef.current;
		const canvas = canvasRef.current;
		if (!video || !canvas) return;

		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;

		const tick = (): void => {
			if (!alive) return;
			raf = requestAnimationFrame(tick);
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
						if (link) {
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
				stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: "environment" },
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
				const facing = settings?.facingMode;
				video.style.transform = facing === "user" ? "scaleX(-1)" : "none";
				await video.play();
				raf = requestAnimationFrame(tick);
			} catch {
				if (alive) setError(t("camera unavailable — use the pair code instead"));
			}
		};
		void start();

		return () => {
			alive = false;
			cancelAnimationFrame(raf);
			stream?.getTracks().forEach(track => track.stop());
		};
	}, [onResult]);

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
		<div className="qr-overlay" role="dialog" aria-modal="true" aria-label={t("scan the QR code")}>
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
				<button type="button" className="qr-close" onClick={onCancel} aria-label={t("close")}>
					✕
				</button>
				<span className="qr-title">{t("scan the QR code")}</span>
				<span className="qr-spacer" aria-hidden="true" />
			</header>

			<footer className="qr-bottom">
				<button type="button" className="qr-torch" onClick={() => void toggleTorch()} aria-pressed={torch}>
					{torch ? "💡" : "🔦"} <span>{t("torch")}</span>
				</button>
				<p className="qr-hint">
					{error ?? t("align the QR code in the frame")}
				</p>
			</footer>
		</div>
	);
}
