import type { MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Vinyl music player — ported 1:1 from the kimiwork "黑胶唱片机" widget
 * (widget_ac74a7f9/workspace/index.html, Internet Archive public-domain
 * recordings). Real audio: archive.org 78rpm transfers of Rachmaninoff
 * playing Chopin (1919–1923), AnalyserNode-driven canvas spectrum.
 *
 * Layout: left screen (spectrum + seek + NOW PLAYING + badges) over
 * transport; right play queue (load-from-top button + numbered rows with
 * cover thumbs + EQ bars on the active row). Degrades gracefully when
 * archive.org is unreachable — same error copy as the original.
 */
export interface MusicTrack {
	title: string;
	artist: string;
	/** Release year shown as a badge. */
	year?: string;
	/** Internet Archive identifier for cover art + audio. */
	id?: string;
	/** Archive.org filename inside the item. */
	file?: string;
}

export function musicDefaults(): Record<string, unknown> {
	return {
		brand: "GT78_ANLZR",
		mode: "78RPM",
		volume: 0.8,
		queue: [
			{
				id: "78_valse-in-d-flat-major_sergei-rachmaninoff-chopin_gbia0012582a",
				year: "1921",
				title: "Valse in D Flat Major",
				artist: "Sergei Rachmaninoff · Chopin",
				file: "Valse in D Flat Major - Sergei Rachmaninoff-restored.mp3",
			},
			{
				id: "78_valse-in-a-flat-op-42_sergei-rachmaninoff-chopin_gbia0307222a",
				year: "1919",
				title: "Valse in A Flat, Op. 42",
				artist: "Sergei Rachmaninoff · Chopin",
				file: "Valse in A Flat Op. 42 - SERGEI RACHMANINOFF.mp3",
			},
			{
				id: "78_mazurka-in-c-sharp-minor_sergei-rachmaninoff-chopin_gbia0015772a",
				year: "1923",
				title: "Mazurka in C Sharp Minor",
				artist: "Sergei Rachmaninoff · Chopin",
				file: "Mazurka (in C Sharp Minor) - Sergei Rachmaninoff-restored.mp3",
			},
		],
	};
}

const BARS = 46;
const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M7 5h3v14H7zM14 5h3v14h-3z";

function fileUrl(id: string, name: string): string {
	return `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(name).replace(/%2F/g, "/")}`;
}
function thumbUrl(id: string): string {
	return `https://archive.org/services/img/${encodeURIComponent(id)}`;
}
function fmt(s: number): string {
	if (!Number.isFinite(s)) return "0:00";
	const m = Math.floor(s / 60);
	const x = Math.floor(s % 60);
	return `${m}:${x < 10 ? "0" : ""}${x}`;
}

export function MusicCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const rawQueue = Array.isArray(data.queue) ? (data.queue as MusicTrack[]) : [];
	const queue = rawQueue.length > 0 ? rawQueue : (musicDefaults().queue as MusicTrack[]);
	const brand = typeof data.brand === "string" && data.brand !== "" ? data.brand : "GT78_ANLZR";
	const mode = typeof data.mode === "string" && data.mode !== "" ? data.mode : "78RPM";

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [current, setCurrent] = useState(-1);
	const [playing, setPlaying] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [tCur, setTCur] = useState("0:00");
	const [tDur, setTDur] = useState("–:––");
	const [progress, setProgress] = useState(0);
	const [vol, setVol] = useState(typeof data.volume === "number" ? data.volume : 0.8);
	const [muted, setMuted] = useState(false);
	const [queueScroll, setQueueScroll] = useState(0);
	const stateRef = useRef({ current: -1, playing: false, vol: 0.8, muted: false });
	stateRef.current = { current, playing, vol, muted };

	// ── canvas spectrum (ported from the kimi viz loop) ────────────────
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const vctx = canvas.getContext("2d");
		if (!vctx) return;
		const audio = audioRef.current;
		let analyser: AnalyserNode | null = null;
		let actx: AudioContext | null = null;
		let freq: Uint8Array<ArrayBuffer> | null = null;
		let wave: Uint8Array<ArrayBuffer> | null = null;
		let analyserDead = false;
		let raf = 0;
		const vals: number[] = [];
		const peaks: number[] = [];
		for (let i = 0; i < BARS; i++) {
			vals.push(0.08);
			peaks.push(0.1);
		}
		const ensureAnalyser = () => {
			if (analyserDead || !audio) return;
			if (actx) {
				if (actx.state === "suspended") actx.resume().catch(() => {});
				return;
			}
			try {
				const AC =
					window.AudioContext ??
					(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
				if (!AC) {
					analyserDead = true;
					return;
				}
				actx = new AC();
				const srcNode = actx.createMediaElementSource(audio);
				analyser = actx.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.74;
				srcNode.connect(analyser);
				analyser.connect(actx.destination);
				freq = new Uint8Array(analyser.frequencyBinCount);
				wave = new Uint8Array(analyser.fftSize);
				if (actx.state === "suspended") actx.resume().catch(() => {});
			} catch {
				analyser = null;
				analyserDead = true;
			}
		};
		const sizeViz = () => {
			const rect = canvas.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			if (rect.width > 0 && rect.height > 0) {
				canvas.width = Math.round(rect.width * dpr);
				canvas.height = Math.round(rect.height * dpr);
			}
		};
		sizeViz();
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sizeViz) : null;
		ro?.observe(canvas);
		let deadFrames = 0;
		const tick = (now: number) => {
			const { playing: isPlaying } = stateRef.current;
			let liveData = false;
			if (isPlaying && analyser && freq && !analyserDead) {
				analyser.getByteFrequencyData(freq);
				let sum = 0;
				for (let k = 0; k < freq.length; k++) sum += freq[k];
				if (sum > 0) {
					liveData = true;
					deadFrames = 0;
				} else if (++deadFrames > 150) {
					analyserDead = true;
				}
			}
			for (let i = 0; i < BARS; i++) {
				let target: number;
				if (liveData) {
					const idx = Math.min(freq!.length - 1, Math.floor((i / (BARS - 1)) ** 1.7 * freq!.length * 0.72));
					target = 0.05 + 0.93 * (freq![idx] / 255);
				} else if (isPlaying) {
					const c = (i / (BARS - 1)) * 2 - 1;
					const bell = Math.exp(-c * c * 1.5);
					const n1 = Math.sin(now / 210 + i * 0.55) * 0.5 + 0.5;
					const n2 = Math.sin(now / 83 + i * 1.7) * 0.5 + 0.5;
					target = 0.12 + 0.86 * bell * (0.3 + 0.7 * n1 * n2);
				} else {
					target = 0.06 + 0.03 * (Math.sin(now / 650 + i * 0.4) * 0.5 + 0.5);
				}
				vals[i] += (target - vals[i]) * (liveData ? 0.45 : 0.32);
				if (vals[i] > peaks[i]) peaks[i] = vals[i];
				else peaks[i] = Math.max(0.04, peaks[i] - 0.006);
			}
			const W = canvas.width;
			const H = canvas.height;
			if (W > 0 && H > 0) {
				vctx.clearRect(0, 0, W, H);
				const baseY = Math.round(H * 0.8);
				const gap = Math.max(1, W * 0.008);
				const bw = (W - gap * (BARS - 1)) / BARS;
				let bass = 0;
				if (liveData && freq) {
					for (let b = 0; b < 10; b++) bass += freq[b];
					bass /= 10 * 255;
				} else {
					bass = isPlaying ? (vals[2] + vals[3]) / 2 : 0.04;
				}
				if (isPlaying) {
					const glow = vctx.createRadialGradient(
						W / 2,
						baseY,
						0,
						W / 2,
						baseY,
						Math.max(10, W * (0.24 + bass * 0.42)),
					);
					glow.addColorStop(0, `rgba(145,212,255,${(0.1 + bass * 0.24).toFixed(3)})`);
					glow.addColorStop(1, "rgba(145,212,255,0)");
					vctx.fillStyle = glow;
					vctx.fillRect(0, 0, W, H);
				}
				const grad = vctx.createLinearGradient(0, baseY, 0, 0);
				grad.addColorStop(0, "rgba(145,212,255,.5)");
				grad.addColorStop(0.6, "#91D4FF");
				grad.addColorStop(1, "#C4E5FF");
				vctx.save();
				vctx.shadowColor = `rgba(145,212,255,${(0.3 + bass * 0.5).toFixed(3)})`;
				vctx.shadowBlur = 5 + bass * 16;
				vctx.fillStyle = grad;
				for (let i = 0; i < BARS; i++) {
					const h = Math.max(2, vals[i] * baseY);
					const x = i * (bw + gap);
					const y = baseY - h;
					vctx.beginPath();
					if (typeof vctx.roundRect === "function") vctx.roundRect(x, y, bw, h, [bw / 2, bw / 2, 0, 0]);
					else vctx.rect(x, y, bw, h);
					vctx.fill();
				}
				vctx.restore();
				vctx.fillStyle = "rgba(183,227,255,.9)";
				for (let i = 0; i < BARS; i++) {
					const py = baseY - Math.max(3, peaks[i] * baseY);
					vctx.fillRect(i * (bw + gap), Math.max(0, py - 2), bw, 2);
				}
				const rgrad = vctx.createLinearGradient(0, baseY, 0, H);
				rgrad.addColorStop(0, "rgba(145,212,255,.20)");
				rgrad.addColorStop(1, "rgba(145,212,255,0)");
				vctx.fillStyle = rgrad;
				const refH = H - baseY;
				for (let i = 0; i < BARS; i++) {
					const rh = Math.min(refH - 2, vals[i] * baseY * 0.35);
					if (rh > 1) vctx.fillRect(i * (bw + gap), baseY + 2, bw, rh);
				}
				if (liveData && wave && analyser) {
					analyser.getByteTimeDomainData(wave);
					vctx.beginPath();
					for (let w0 = 0; w0 < wave.length; w0 += 2) {
						const wx = (w0 / (wave.length - 1)) * W;
						const wy = baseY * 0.46 + ((wave[w0] - 128) / 128) * baseY * 0.3;
						if (w0 === 0) vctx.moveTo(wx, wy);
						else vctx.lineTo(wx, wy);
					}
					vctx.strokeStyle = "rgba(255,255,255,.32)";
					vctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
					vctx.stroke();
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		audio?.addEventListener("play", ensureAnalyser);
		return () => {
			cancelAnimationFrame(raf);
			ro?.disconnect();
			audio?.removeEventListener("play", ensureAnalyser);
			void actx?.close().catch(() => {});
		};
	}, []);

	// ── transport ──────────────────────────────────────────────────────
	const audio = audioRef.current;
	const select = (index: number, autoplay: boolean) => {
		const t = queue[index];
		const a = audioRef.current;
		if (!t || !a) return;
		setCurrent(index);
		setLoadFailed(false);
		setTCur("0:00");
		setTDur("–:––");
		setProgress(0);
		const url = t.id && t.file ? fileUrl(t.id, t.file) : "";
		if (!url) {
			setLoadFailed(true);
			return;
		}
		a.src = url;
		if (autoplay) a.play().catch(() => {});
	};
	const toggle = () => {
		const a = audioRef.current;
		if (!a) return;
		if (stateRef.current.current < 0 && queue.length) select(0, true);
		else if (a.paused) a.play().catch(() => {});
		else a.pause();
	};
	const step = (d: number) => {
		if (queue.length) select((stateRef.current.current + d + queue.length) % queue.length, true);
	};
	const seek = (e: MouseEvent<HTMLDivElement>) => {
		const a = audioRef.current;
		if (!a || !a.duration) return;
		const r = e.currentTarget.getBoundingClientRect();
		a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
	};
	const onVol = (v: number) => {
		setVol(v);
		setMuted(false);
		update({ volume: v });
		if (audioRef.current) {
			audioRef.current.muted = false;
			audioRef.current.volume = v;
		}
	};
	const onMute = () => {
		const a = audioRef.current;
		if (!a) return;
		a.muted = !a.muted;
		setMuted(a.muted);
	};

	const currentTrack = current >= 0 && current < queue.length ? queue[current] : null;

	return (
		<div className="gui-widget-music">
			<audio
				ref={audioRef}
				preload="none"
				crossOrigin="anonymous"
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onEnded={() => step(1)}
				onError={() => {
					setPlaying(false);
					setLoadFailed(true);
				}}
				onTimeUpdate={e => {
					const a = e.currentTarget;
					setProgress(a.duration ? (a.currentTime / a.duration) * 100 : 0);
					setTCur(fmt(a.currentTime));
				}}
				onLoadedMetadata={e => setTDur(fmt(e.currentTarget.duration))}
			/>

			<section className="gui-widget-music-left">
				<div className="gui-widget-music-screen">
					<div className="gui-widget-music-scrtop">
						<span>
							{brand} · {mode}
						</span>
						<span className="gui-widget-music-dots">
							<i />
							<i className={playing ? "gui-widget-music-live" : ""} />
						</span>
					</div>
					<canvas ref={canvasRef} className="gui-widget-music-viz" />
					<div className="gui-widget-music-seekrow">
						<span className="gui-widget-music-t">{tCur}</span>
						<div className="gui-widget-music-seek" onClick={seek}>
							<span className="gui-widget-music-fill" style={{ width: `${progress}%` }} />
						</div>
						<span className="gui-widget-music-t gui-widget-music-t--dur">{tDur}</span>
					</div>
					<div className="gui-widget-music-scrfoot">
						<div className="gui-widget-music-np">
							<div className="gui-widget-music-eyebrow">Now Playing</div>
							<h1 className="gui-widget-music-title">
								{loadFailed ? "唱片加载失败" : currentTrack ? currentTrack.title : "正在连接…"}
							</h1>
							<div className="gui-widget-music-by">
								{loadFailed
									? "无法加载此曲目，请重试或切换 · " + (currentTrack?.year ?? "")
									: currentTrack
										? `${currentTrack.artist} · ${currentTrack.year}`
										: "只收录 1930 年及以前已进入公共领域的录音"}
							</div>
						</div>
						<div className="gui-widget-music-badges">
							<span className="gui-widget-music-badge">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
									<circle cx="12" cy="12" r="9" />
									<circle cx="12" cy="12" r="2.5" />
								</svg>
								HQ
							</span>
							{currentTrack?.year && (
								<span className="gui-widget-music-badge gui-widget-music-badge--acc">{currentTrack.year}</span>
							)}
						</div>
					</div>
				</div>
				<div className="gui-widget-music-transport">
					<button
						type="button"
						className="gui-widget-music-tbtn gui-widget-music-tbtn--side"
						onClick={() => step(-1)}
						aria-label="上一首"
					>
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d="M7 5h2v14H7zM20 5v14L9 12z" />
						</svg>
					</button>
					<button
						type="button"
						className="gui-widget-music-tbtn gui-widget-music-tbtn--play"
						onClick={toggle}
						aria-label="播放/暂停"
					>
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d={playing ? ICON_PAUSE : ICON_PLAY} />
						</svg>
					</button>
					<button
						type="button"
						className="gui-widget-music-tbtn gui-widget-music-tbtn--side"
						onClick={() => step(1)}
						aria-label="下一首"
					>
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d="M15 5h2v14h-2zM4 5l11 7-11 7z" />
						</svg>
					</button>
					<div className="gui-widget-music-volwrap">
						<button
							type="button"
							className={`gui-widget-music-vbtn${muted ? " gui-widget-music-vbtn--muted" : ""}`}
							onClick={onMute}
							aria-label="静音"
						>
							<svg viewBox="0 0 24 24" fill="currentColor">
								<path d="M4 9v6h4l5 5V4L8 9H4z" />
								<path
									d={muted ? "M16 9l6 6M22 9l-6 6" : "M16 8.5a4 4 0 010 7"}
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								/>
							</svg>
						</button>
						<input
							className="gui-widget-music-vol"
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={vol}
							style={{ ["--vp" as string]: `${vol * 100}%` }}
							onChange={e => onVol(Number(e.target.value))}
							aria-label="音量"
						/>
					</div>
				</div>
			</section>

			<section className="gui-widget-music-right">
				<div className="gui-widget-music-qhead">
					<h2>播放队列</h2>
					<button
						type="button"
						className="gui-widget-music-menu"
						aria-label="菜单"
						onClick={() => setQueueScroll(q => q + 1)}
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
							<path d="M4 7h16M4 12h16M4 17h16" />
						</svg>
					</button>
				</div>
				<button type="button" className="gui-widget-music-qload" onClick={() => queue.length && select(0, true)}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
					从头播放队列
				</button>
				<div className="gui-widget-music-qlist" key={queueScroll}>
					{queue.map((t, i) => (
						<button
							key={`${t.id ?? t.title}-${i}`}
							type="button"
							className={`gui-widget-music-qitem${i === current ? " gui-widget-music-qitem--on" : ""}`}
							onClick={() => select(i, true)}
						>
							<span className="gui-widget-music-qidx">
								{i < 9 ? "0" : ""}
								{i + 1}
							</span>
							{t.id ? (
								<img
									className="gui-widget-music-qthumb"
									loading="lazy"
									alt=""
									src={thumbUrl(t.id)}
									onError={e => {
										(e.currentTarget as HTMLImageElement).style.visibility = "hidden";
									}}
								/>
							) : (
								<span className="gui-widget-music-qthumb gui-widget-music-qthumb--blank" />
							)}
							<span className="gui-widget-music-qmeta">
								<b>{t.title}</b>
								<span>
									<svg viewBox="0 0 24 24" fill="currentColor">
										<path d="M9 18V5l10-2v13" />
										<circle cx="6" cy="18" r="3" />
										<circle cx="16" cy="16" r="3" />
									</svg>
									{t.artist}
								</span>
							</span>
							<span className="gui-widget-music-qtag">
								<span className="gui-widget-music-eq">
									<i />
									<i />
									<i />
								</span>
								{t.year}
							</span>
						</button>
					))}
				</div>
			</section>
		</div>
	);
}
