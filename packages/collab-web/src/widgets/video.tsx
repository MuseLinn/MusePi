import type { ReactNode } from "react";
import { useRef, useState } from "react";

/**
 * Video card — kimi PROMO REEL parity: black card with dot-matrix mask,
 * corner brackets, REC-style HUD, custom transport bar (play/seek/mute/
 * fullscreen) and a big play button over the cover. Two source modes:
 *
 * - `data.url` — direct mp4, played in-card with the transport bar.
 * - `data.bvid` — Bilibili video id, embedded via the official player
 *   iframe (cover click → inline playback, no page navigation).
 *
 * Defaults point at 凡人修仙传 (Bilibili 年番) so a fresh card is already
 * watchable; empty url+bvid keeps the decorative composition cover.
 */
export function videoDefaults(): Record<string, unknown> {
	return {
		url: "",
		bvid: "BV1vT411d7QE",
		title: "凡人修仙传",
		subtitle: "BILIBILI · 年番",
	};
}

function fmt(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "00:00";
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Cover({
	title,
	subtitle,
	onPlay,
}: {
	title: string;
	subtitle: string;
	onPlay?: () => void;
}): ReactNode {
	return (
		<div className="gui-widget-video gui-widget-video--cover" onClick={onPlay}>
			<span className="gui-widget-video-corner c-tl" />
			<span className="gui-widget-video-corner c-tr" />
			<span className="gui-widget-video-corner c-bl" />
			<span className="gui-widget-video-corner c-br" />
			<span className="gui-widget-video-hud">
				<i /> PROMO REEL
			</span>
			<div className="gui-widget-video-cover-mid">
				<span className="gui-widget-video-bigplay">▶</span>
			</div>
			<div className="gui-widget-video-cover-bottom">
				<span className="gui-widget-video-cover-title">{title}</span>
				{subtitle && <span className="gui-widget-video-cover-sub">{subtitle}</span>}
			</div>
		</div>
	);
}

export function VideoCard({
	data,
	update,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
}): ReactNode {
	const url = typeof data.url === "string" ? data.url : "";
	const bvid = typeof data.bvid === "string" ? data.bvid : "";
	const title = typeof data.title === "string" && data.title !== "" ? data.title : "凡人修仙传";
	const subtitle = typeof data.subtitle === "string" ? data.subtitle : "";
	const isBili = bvid !== "" && url === "";
	const [playing, setPlaying] = useState(false);
	const [paused, setPaused] = useState(true);
	const [t, setT] = useState(0);
	const [dur, setDur] = useState(0);
	const [muted, setMuted] = useState(false);
	const vref = useRef<HTMLVideoElement>(null);
	const seekRef = useRef<HTMLDivElement>(null);

	if (!url && !bvid) {
		// Decorative composition placeholder (no source yet).
		return <Cover title={title} subtitle={subtitle} />;
	}

	if (isBili && !playing) {
		return <Cover title={title} subtitle={subtitle} onPlay={() => setPlaying(true)} />;
	}

	if (isBili) {
		return (
			<div className="gui-widget-video">
				<iframe
					className="gui-widget-video-el"
					src={`https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=1&high_quality=1`}
					// No fullscreen permission: the video must stay embedded in
					// the board card. allowFullScreen let the Bilibili player
					// take over the whole window when its fullscreen button was
					// clicked, which read as "jumps to the Bilibili player".
					allow="autoplay; encrypted-media; picture-in-picture"
					scrolling="no"
					title={title}
				/>
			</div>
		);
	}

	const togglePlay = (): void => {
		const v = vref.current;
		if (!v) return;
		if (v.paused) void v.play();
		else v.pause();
	};
	const seek = (clientX: number): void => {
		const v = vref.current;
		const bar = seekRef.current;
		if (!v || !bar || !Number.isFinite(v.duration)) return;
		const r = bar.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		v.currentTime = ratio * v.duration;
		setT(v.currentTime);
	};

	return (
		<div className="gui-widget-video">
			<video
				className="gui-widget-video-el"
				ref={vref}
				src={url}
				playsInline
				preload="metadata"
				muted={muted}
				onPlay={() => setPaused(false)}
				onPause={() => setPaused(true)}
				onEnded={() => setPaused(true)}
				onTimeUpdate={e => setT(e.currentTarget.currentTime)}
				onLoadedMetadata={e => setDur(e.currentTarget.duration)}
			/>
			<span className="gui-widget-video-corner c-tl" />
			<span className="gui-widget-video-corner c-tr" />
			<span className="gui-widget-video-corner c-bl" />
			<span className="gui-widget-video-corner c-br" />
			<span className={`gui-widget-video-hud${paused ? "" : " on"}`}>
				<i /> PROMO REEL
			</span>
			<span className="gui-widget-video-dur">{fmt(dur)}</span>
			<button
				type="button"
				className="gui-widget-video-bigplay"
				style={{ opacity: paused ? 1 : 0, pointerEvents: paused ? "auto" : "none" }}
				onClick={togglePlay}
				aria-label="播放"
			>
				▶
			</button>
			<div className="gui-widget-video-bar">
				<button type="button" className="gui-widget-video-bar-btn" onClick={togglePlay} aria-label="播放/暂停">
					{paused ? "▶" : "❚❚"}
				</button>
				<div
					ref={seekRef}
					className="gui-widget-video-seek"
					onClick={e => seek(e.clientX)}
					onPointerDown={e => {
						e.currentTarget.setPointerCapture(e.pointerId);
						seek(e.clientX);
					}}
					onPointerMove={e => {
						if (e.buttons & 1) seek(e.clientX);
					}}
				>
					<div className="gui-widget-video-track">
						<div className="gui-widget-video-fill" style={{ width: `${dur > 0 ? (t / dur) * 100 : 0}%` }} />
						<div
							className="gui-widget-video-knob"
							style={{ left: `${dur > 0 ? (t / dur) * 100 : 0}%` }}
						/>
					</div>
				</div>
				<span className="gui-widget-video-tc">
					{fmt(t)} / {fmt(dur)}
				</span>
				<button
					type="button"
					className="gui-widget-video-bar-btn"
					onClick={() => {
						setMuted(m => !m);
						if (vref.current) vref.current.muted = !muted;
					}}
					aria-label="静音"
				>
					{muted ? "♪̶" : "♪"}
				</button>
				<button
					type="button"
					className="gui-widget-video-bar-btn"
					onClick={() => void vref.current?.requestFullscreen()}
					aria-label="全屏"
				>
					⛶
				</button>
			</div>
		</div>
	);
}
