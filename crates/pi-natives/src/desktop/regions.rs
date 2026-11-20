#![allow(clippy::redundant_pub_crate, reason = "crate-visible helpers inside a private desktop module")]
//! Zero-dependency region proposals over a captured screenshot frame.
//!
//! The detector proposes rectangles from image structure alone: grayscale,
//! Sobel magnitude, an adaptive threshold, connected components, row clustering
//! and rectangle merging. A proposal is not an element — there is no OCR, no
//! label and no semantics — and every rectangle is a half-open area in the
//! pixels of the frame the caller last saw, the same space `FrameGeometry` maps
//! pointer input through.
//!
//! The frame cache keeps the analysis pixels of the most recent captures
//! under a fixed frame count and byte budget. An evicted target reports
//! `NoFrame` so the caller re-captures instead of reading stale proposals.

use std::collections::VecDeque;

use image::{GrayImage, RgbaImage};

/// Most proposals one call returns when the caller does not ask for a count.
pub(crate) const DEFAULT_MAX_REGIONS: u32 = 24;
/// Largest proposal count a call may request.
pub(crate) const MAX_REGIONS: u32 = 64;
/// Cached frames, most recent last. A tool interleaves at most a window and
/// the desktop, so two entries keep both hot.
pub(crate) const MAX_CACHED_FRAMES: usize = 2;
/// Total luma bytes the cache may hold across every cached frame.
pub(crate) const MAX_CACHED_BYTES: usize = 24 * 1024 * 1024;

const MIN_FRAME_EDGE: u32 = 24;
/// Longest analysis-grid edge. Larger frames are box-averaged down to this,
/// bounding the analysis cost independently of screen resolution.
const ANALYSIS_EDGE: u32 = 1280;
/// Luma range at or below which a frame carries no structure at all.
const UNIFORM_RANGE: u8 = 4;
const MIN_EDGE_STRENGTH: u32 = 16;
const MAX_EDGE_STRENGTH: u32 = 96;
const MIN_EDGE_CELLS: usize = 24;
const MIN_COMPONENT_CELLS: usize = 3;
/// Components one analysis may collect. A frame with more structure than this
/// is scenic rather than an interface, so the scan stops and the result is
/// reported as truncated.
const MAX_COMPONENTS: usize = 1024;
const MIN_REGION_EDGE_PX: u32 = 8;
const MIN_REGION_AREA_PX: u64 = 64;
/// A rectangle covering more than this share of the frame is the frame, not a
/// proposal.
const MAX_REGION_FRAME_RATIO: f64 = 0.92;

/// Luma frame retained for region analysis.
///
/// One byte per frame pixel: the detector reads luma only, so keeping the
/// RGBA capture would quadruple the same budget for no analysis gain.
pub(crate) struct FrameCache {
	entries: VecDeque<(String, GrayImage)>,
	bytes:   usize,
}

impl FrameCache {
	pub(crate) const fn new() -> Self {
		Self { entries: VecDeque::new(), bytes: 0 }
	}

	/// Stores the newest frame of `key`, evicting older frames until both the
	/// frame count and the byte budget hold. A single frame larger than the
	/// whole budget is not cached, so a later analysis reports `NoFrame`
	/// rather than silently breaking the bound.
	pub(crate) fn insert(&mut self, key: String, frame: GrayImage) {
		self.remove(&key);
		let size = frame.as_raw().len();
		if size > MAX_CACHED_BYTES {
			return;
		}
		while !self.entries.is_empty()
			&& (self.entries.len() >= MAX_CACHED_FRAMES || self.bytes + size > MAX_CACHED_BYTES)
		{
			self.evict_oldest();
		}
		self.bytes += size;
		self.entries.push_back((key, frame));
	}

	pub(crate) fn get(&self, key: &str) -> Option<&GrayImage> {
		self
			.entries
			.iter()
			.rev()
			.find(|(cached, _)| cached == key)
			.map(|(_, frame)| frame)
	}

	#[cfg(test)]
	pub(crate) fn len(&self) -> usize {
		self.entries.len()
	}

	#[cfg(test)]
	pub(crate) fn bytes(&self) -> usize {
		self.bytes
	}

	fn remove(&mut self, key: &str) {
		let index = self.entries.iter().position(|(cached, _)| cached == key);
		if let Some((_, frame)) = index.and_then(|index| self.entries.remove(index)) {
			self.bytes -= frame.as_raw().len();
		}
	}

	fn evict_oldest(&mut self) {
		if let Some((_, frame)) = self.entries.pop_front() {
			self.bytes -= frame.as_raw().len();
		}
	}
}

/// Why a frame produced no proposals. An empty list with a reason is a
/// successful analysis that found nothing, never a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EmptyReason {
	Uniform,
	LowContrast,
	TooSmall,
}

impl EmptyReason {
	pub(crate) const fn as_str(self) -> &'static str {
		match self {
			Self::Uniform => "uniform",
			Self::LowContrast => "low_contrast",
			Self::TooSmall => "too_small",
		}
	}
}

/// One proposal: a half-open rectangle in screenshot-frame pixels.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Proposal {
	pub(crate) x:          u32,
	pub(crate) y:          u32,
	pub(crate) width:      u32,
	pub(crate) height:     u32,
	pub(crate) kind:       &'static str,
	pub(crate) confidence: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct RegionProposals {
	pub(crate) regions:   Vec<Proposal>,
	pub(crate) truncated: bool,
	pub(crate) reason:    Option<EmptyReason>,
}

/// Converts a captured frame to the luma plane the cache and detector use.
pub(crate) fn luma_frame(image: &RgbaImage) -> GrayImage {
	let (width, height) = image.dimensions();
	let luma = image
		.pixels()
		.map(|pixel| {
			((77 * u32::from(pixel[0]) + 150 * u32::from(pixel[1]) + 29 * u32::from(pixel[2])) >> 8)
				as u8
		})
		.collect();
	GrayImage::from_raw(width, height, luma).expect("luma frame keeps the capture dimensions")
}

/// Proposes regions for `frame`, in its own pixel coordinates.
pub(crate) fn propose(frame: &GrayImage, max_regions: u32) -> RegionProposals {
	let (frame_width, frame_height) = frame.dimensions();
	let max_regions = max_regions.clamp(1, MAX_REGIONS);
	if frame_width < MIN_FRAME_EDGE || frame_height < MIN_FRAME_EDGE {
		return empty(EmptyReason::TooSmall);
	}
	let Some(grid) = Grid::sample(frame) else {
		return empty(EmptyReason::TooSmall);
	};
	let Some(range) = grid.range() else {
		return empty(EmptyReason::Uniform);
	};
	if range <= UNIFORM_RANGE {
		return empty(EmptyReason::Uniform);
	}
	let Some(mask) = grid.edge_mask() else {
		return empty(EmptyReason::LowContrast);
	};
	let edge_cells = mask.iter().filter(|edge| **edge).count();
	if edge_cells < MIN_EDGE_CELLS {
		return empty(EmptyReason::LowContrast);
	}
	let (components, components_capped) = grid.components(&mask);
	if components.is_empty() {
		return empty(EmptyReason::LowContrast);
	}
	let mut rects = cluster_rows(&components);
	rects = merge_rects(rects, u64::from(frame_width) * u64::from(frame_height));
	rects.retain(|rect| {
		let (x, y, width, height) = grid.to_frame(rect, frame_width as usize, frame_height as usize);
		width >= MIN_REGION_EDGE_PX
			&& height >= MIN_REGION_EDGE_PX
			&& u64::from(width) * u64::from(height) >= MIN_REGION_AREA_PX
			&& f64::from(width) * f64::from(height)
				< MAX_REGION_FRAME_RATIO * f64::from(frame_width) * f64::from(frame_height)
			&& x + width <= frame_width
			&& y + height <= frame_height
	});
	if rects.is_empty() {
		return empty(EmptyReason::LowContrast);
	}
	let mut proposals: Vec<Proposal> = rects
		.iter()
		.map(|rect| {
			let (x, y, width, height) =
				grid.to_frame(rect, frame_width as usize, frame_height as usize);
			let support = grid.boundary_support(&mask, rect);
			Proposal {
				x,
				y,
				width,
				height,
				kind: kind_for(width, height),
				confidence: (0.65f64.mul_add(support, 0.35) * 100.0).round() / 100.0,
			}
		})
		.collect();
	let truncated = components_capped || proposals.len() > max_regions as usize;
	if truncated {
		proposals.sort_by(|left, right| {
			right
				.confidence
				.total_cmp(&left.confidence)
				.then_with(|| {
					(u64::from(right.width) * u64::from(right.height))
						.cmp(&(u64::from(left.width) * u64::from(left.height)))
				})
				.then_with(|| (left.y, left.x).cmp(&(right.y, right.x)))
		});
		proposals.truncate(max_regions as usize);
	}
	proposals.sort_by_key(|proposal| (proposal.y, proposal.x, proposal.height, proposal.width));
	RegionProposals { regions: proposals, truncated, reason: None }
}

const fn empty(reason: EmptyReason) -> RegionProposals {
	RegionProposals { regions: Vec::new(), truncated: false, reason: Some(reason) }
}

const fn kind_for(width: u32, height: u32) -> &'static str {
	if height <= 24 && width >= height.saturating_mul(4) {
		"text"
	} else if width >= height.saturating_mul(4) {
		"row"
	} else {
		"block"
	}
}

/// Analysis grid: box-averaged luma cells over the frame.
struct Grid {
	width:  usize,
	height: usize,
	step:   u32,
	luma:   Vec<u8>,
}

impl Grid {
	fn sample(frame: &GrayImage) -> Option<Self> {
		let (width, height) = frame.dimensions();
		if width == 0 || height == 0 {
			return None;
		}
		let step = width.max(height).div_ceil(ANALYSIS_EDGE).max(1);
		let columns = width.div_ceil(step) as usize;
		let rows = height.div_ceil(step) as usize;
		let mut luma = vec![0u8; columns * rows];
		if step == 1 {
			for y in 0..rows {
				for x in 0..columns {
					luma[y * columns + x] = frame.get_pixel(x as u32, y as u32)[0];
				}
			}
		} else {
			for y in 0..rows {
				let top = y as u32 * step;
				let bottom = (top + step).min(height);
				for x in 0..columns {
					let left = x as u32 * step;
					let right = (left + step).min(width);
					let mut sum = 0u64;
					let mut count = 0u64;
					for py in top..bottom {
						for px in left..right {
							sum += u64::from(frame.get_pixel(px, py)[0]);
							count += 1;
						}
					}
					luma[y * columns + x] = u8::try_from(sum / count.max(1)).unwrap_or(u8::MAX);
				}
			}
		}
		Some(Self { width: columns, height: rows, step, luma })
	}

	fn range(&self) -> Option<u8> {
		let (min, max) = self
			.luma
			.iter()
			.fold((u8::MAX, u8::MIN), |(min, max), luma| (min.min(*luma), max.max(*luma)));
		(self.width > 0 && self.height > 0).then(|| max - min)
	}

	/// Sobel magnitude with an adaptive threshold: mean plus one standard
	/// deviation of the interior magnitudes, clamped to a floor that ignores
	/// dithering and a ceiling that still admits low-contrast edges.
	fn edge_mask(&self) -> Option<Vec<bool>> {
		if self.width < 3 || self.height < 3 {
			return None;
		}
		let mut magnitudes = vec![0u32; self.width * self.height];
		for y in 1..self.height - 1 {
			for x in 1..self.width - 1 {
				let at = |dx: isize, dy: isize| {
					let column = (x as isize + dx) as usize;
					let row = (y as isize + dy) as usize;
					u32::from(self.luma[row * self.width + column])
				};
				let gx = i64::from(at(1, -1) + 2 * at(1, 0) + at(1, 1))
					- i64::from(at(-1, -1) + 2 * at(-1, 0) + at(-1, 1));
				let gy = i64::from(at(-1, 1) + 2 * at(0, 1) + at(1, 1))
					- i64::from(at(-1, -1) + 2 * at(0, -1) + at(1, -1));
				magnitudes[y * self.width + x] = u32::try_from((gx.abs() + gy.abs()) / 4).unwrap_or(0);
			}
		}
		let interior = ((self.width - 2) * (self.height - 2)) as u64;
		let sum: u64 = magnitudes.iter().map(|value| u64::from(*value)).sum();
		let mean = sum as f64 / interior as f64;
		let variance = magnitudes
			.iter()
			.map(|value| {
				let delta = f64::from(*value) - mean;
				delta * delta
			})
			.sum::<f64>()
			/ interior as f64;
		let threshold = (mean + variance.sqrt())
			.round()
			.clamp(f64::from(MIN_EDGE_STRENGTH), f64::from(MAX_EDGE_STRENGTH)) as u32;
		let mask = magnitudes.iter().map(|value| *value >= threshold).collect();
		Some(mask)
	}

	/// 8-connected components of the edge mask, kept as their bounding boxes.
	/// The flag reports whether the component budget cut the scan short.
	fn components(&self, mask: &[bool]) -> (Vec<Rect>, bool) {
		let mut visited = vec![false; mask.len()];
		let mut components = Vec::new();
		let mut stack = Vec::new();
		let mut capped = false;
		for start in 0..mask.len() {
			if !mask[start] || visited[start] {
				continue;
			}
			stack.clear();
			stack.push(start);
			visited[start] = true;
			let mut rect = Rect {
				left:   start % self.width,
				right:  start % self.width + 1,
				top:    start / self.width,
				bottom: start / self.width + 1,
			};
			let mut cells = 0usize;
			while let Some(index) = stack.pop() {
				cells += 1;
				let x = index % self.width;
				let y = index / self.width;
				rect.left = rect.left.min(x);
				rect.right = rect.right.max(x + 1);
				rect.top = rect.top.min(y);
				rect.bottom = rect.bottom.max(y + 1);
				for dy in -1isize..=1 {
					for dx in -1isize..=1 {
						if dx == 0 && dy == 0 {
							continue;
						}
						let nx = x as isize + dx;
						let ny = y as isize + dy;
						if nx < 0 || ny < 0 || nx >= self.width as isize || ny >= self.height as isize {
							continue;
						}
						let next = ny as usize * self.width + nx as usize;
						if mask[next] && !visited[next] {
							visited[next] = true;
							stack.push(next);
						}
					}
				}
			}
			if cells >= MIN_COMPONENT_CELLS {
				components.push(rect);
				if components.len() >= MAX_COMPONENTS {
					capped = true;
					break;
				}
			}
		}
		(components, capped)
	}

	fn to_frame(&self, rect: &Rect, width: usize, height: usize) -> (u32, u32, u32, u32) {
		let step = self.step;
		let left = (u32::try_from(rect.left).unwrap_or(u32::MAX)).saturating_mul(step);
		let top = (u32::try_from(rect.top).unwrap_or(u32::MAX)).saturating_mul(step);
		let right = (u32::try_from(rect.right).unwrap_or(u32::MAX))
			.saturating_mul(step)
			.min(u32::try_from(width).unwrap_or(u32::MAX));
		let bottom = (u32::try_from(rect.bottom).unwrap_or(u32::MAX))
			.saturating_mul(step)
			.min(u32::try_from(height).unwrap_or(u32::MAX));
		(left, top, right.saturating_sub(left), bottom.saturating_sub(top))
	}

	/// Share of the rectangle's perimeter that sits on (or next to) an edge
	/// cell, sampled evenly so a large proposal costs a bounded number of
	/// probes. This is the proposal's evidence, not its meaning.
	fn boundary_support(&self, mask: &[bool], rect: &Rect) -> f64 {
		let width = rect.width();
		let height = rect.height();
		if width == 0 || height == 0 {
			return 0.0;
		}
		let perimeter = 2 * (width + height);
		let stride = (perimeter / 256).max(1);
		let mut hits = 0usize;
		let mut samples = 0usize;
		let mut probe = |x: usize, y: usize| {
			samples += 1;
			if self.edge_near(mask, x, y) {
				hits += 1;
			}
		};
		let mut x = rect.left;
		while x < rect.right {
			probe(x, rect.top);
			probe(x, rect.bottom - 1);
			x += stride;
		}
		let mut y = rect.top;
		while y < rect.bottom {
			probe(rect.left, y);
			probe(rect.right - 1, y);
			y += stride;
		}
		if samples == 0 {
			0.0
		} else {
			hits as f64 / samples as f64
		}
	}

	fn edge_near(&self, mask: &[bool], x: usize, y: usize) -> bool {
		for dy in -1isize..=1 {
			for dx in -1isize..=1 {
				let nx = x as isize + dx;
				let ny = y as isize + dy;
				if nx < 0 || ny < 0 || nx >= self.width as isize || ny >= self.height as isize {
					continue;
				}
				if mask[ny as usize * self.width + nx as usize] {
					return true;
				}
			}
		}
		false
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
	left:   usize,
	right:  usize,
	top:    usize,
	bottom: usize,
}

impl Rect {
	const fn width(self) -> usize {
		self.right - self.left
	}

	const fn height(self) -> usize {
		self.bottom - self.top
	}

	const fn area(self) -> u64 {
		self.width() as u64 * self.height() as u64
	}

	fn union(self, other: Self) -> Self {
		Self {
			left:   self.left.min(other.left),
			right:  self.right.max(other.right),
			top:    self.top.min(other.top),
			bottom: self.bottom.max(other.bottom),
		}
	}

	const fn contains(self, other: Self) -> bool {
		self.left <= other.left
			&& self.top <= other.top
			&& self.right >= other.right
			&& self.bottom >= other.bottom
	}
}

/// Horizontal projection clustering: components overlapping vertically form
/// one band, and components inside a band merge when they sit close enough to
/// read as one row. The band's height sets that gap, so a dense toolbar row
/// merges while two separate cards in the same band stay apart.
fn cluster_rows(components: &[Rect]) -> Vec<Rect> {
	struct Band {
		top:     usize,
		bottom:  usize,
		members: Vec<Rect>,
	}
	let mut bands: Vec<Band> = Vec::new();
	for component in components {
		let mut best: Option<(usize, usize)> = None;
		for (index, band) in bands.iter().enumerate() {
			let overlap = component
				.bottom
				.min(band.bottom)
				.saturating_sub(component.top.max(band.top));
			let smaller = component.height().min(band.bottom - band.top);
			if smaller > 0 && overlap * 100 >= smaller * 40 {
				best = match best {
					Some((best_overlap, _)) if best_overlap >= overlap => best,
					_ => Some((overlap, index)),
				};
			}
		}
		match best {
			Some((_, index)) => {
				let band = &mut bands[index];
				band.top = band.top.min(component.top);
				band.bottom = band.bottom.max(component.bottom);
				band.members.push(*component);
			},
			None => bands.push(Band {
				top:     component.top,
				bottom:  component.bottom,
				members: vec![*component],
			}),
		}
	}
	let mut rows = Vec::new();
	for mut band in bands {
		band.members.sort_by_key(|rect| (rect.left, rect.top));
		let gap = ((band.bottom - band.top) / 4).clamp(1, 8);
		let mut merged: Vec<Rect> = Vec::new();
		for member in band.members {
			match merged.last_mut() {
				Some(current) if member.left <= current.right + gap => {
					*current = current.union(member);
				},
				_ => merged.push(member),
			}
		}
		rows.extend(merged);
	}
	rows
}

/// Merges boxes that touch or overlap into one proposal and drops boxes a
/// larger proposal already contains. The frame-area guard keeps a chained
/// merge from swallowing the whole screen.
fn merge_rects(rects: Vec<Rect>, frame_area: u64) -> Vec<Rect> {
	let mut merged: Vec<Rect> = Vec::new();
	for rect in rects {
		let mut absorbed = false;
		for current in &mut merged {
			if rect.left <= current.right
				&& current.left <= rect.right
				&& rect.top <= current.bottom
				&& current.top <= rect.bottom
			{
				let union = current.union(rect);
				if union.area() * 100 <= frame_area * 92 {
					*current = union;
					absorbed = true;
					break;
				}
			}
		}
		if !absorbed {
			merged.push(rect);
		}
	}
	let mut keep = vec![true; merged.len()];
	for (index, rect) in merged.iter().enumerate() {
		for (other_index, other) in merged.iter().enumerate() {
			if index != other_index && other.contains(*rect) && other.area() > rect.area() {
				keep[index] = false;
				break;
			}
		}
	}
	merged
		.into_iter()
		.zip(keep)
		.filter_map(|(rect, keep)| keep.then_some(rect))
		.collect()
}

#[cfg(test)]
mod tests {
	use image::Luma;

	use super::*;

	fn black(width: u32, height: u32) -> GrayImage {
		GrayImage::from_pixel(width, height, Luma([0]))
	}

	fn frame_with_boxes(width: u32, height: u32, boxes: &[(u32, u32, u32, u32)]) -> GrayImage {
		let mut frame = GrayImage::from_pixel(width, height, Luma([32]));
		for (x, y, w, h) in boxes {
			for py in *y..(*y + *h).min(height) {
				for px in *x..(*x + *w).min(width) {
					frame.put_pixel(px, py, Luma([224]));
				}
			}
		}
		frame
	}

	#[test]
	fn uniform_frames_report_uniform_and_never_fabricate_regions() {
		for frame in [black(320, 200), GrayImage::from_pixel(320, 200, Luma([128]))] {
			let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
			assert!(proposals.regions.is_empty(), "a flat frame carries no proposal");
			assert_eq!(proposals.reason, Some(EmptyReason::Uniform));
			assert!(!proposals.truncated);
		}
	}

	#[test]
	fn low_contrast_frames_report_low_contrast() {
		// A smooth ramp carries a wide luma range but no edge steep enough to
		// propose anything: "not uniform" must not be mistaken for "structured".
		let frame = GrayImage::from_fn(320, 200, |x, _| Luma([(x * 255 / 319) as u8]));
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		assert!(proposals.regions.is_empty());
		assert_eq!(proposals.reason, Some(EmptyReason::LowContrast));
	}

	#[test]
	fn tiny_frames_report_too_small() {
		let proposals = propose(&black(12, 200), DEFAULT_MAX_REGIONS);
		assert!(proposals.regions.is_empty());
		assert_eq!(proposals.reason, Some(EmptyReason::TooSmall));
	}

	#[test]
	fn detects_a_card_in_frame_pixels() {
		let frame = frame_with_boxes(320, 240, &[(40, 50, 160, 100)]);
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		let region = proposals
			.regions
			.iter()
			.find(|region| region.x <= 40 && region.y <= 50 && region.x + region.width >= 200)
			.expect("the card must be proposed");
		assert!(region.x.abs_diff(40) <= 2, "left edge {}", region.x);
		assert!(region.y.abs_diff(50) <= 2, "top edge {}", region.y);
		assert!((region.x + region.width).abs_diff(200) <= 2, "right edge");
		assert!((region.y + region.height).abs_diff(150) <= 2, "bottom edge");
		assert!(region.confidence >= 0.35 && region.confidence <= 1.0);
		assert_eq!(region.kind, "block");
		assert!(proposals.reason.is_none());
	}

	#[test]
	fn adjacent_controls_in_one_row_merge_into_one_row_proposal() {
		let frame = frame_with_boxes(320, 200, &[(40, 60, 80, 40), (126, 60, 80, 40)]);
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		let row = proposals
			.regions
			.iter()
			.find(|region| region.y <= 60 && region.y + region.height >= 100 && region.width > 120)
			.expect("a row-level proposal spans both controls");
		assert!(row.x <= 40 && row.x + row.width >= 206);
		assert_eq!(row.kind, "row");
	}

	#[test]
	fn proposals_stay_inside_the_frame_and_truncate() {
		let boxes: Vec<(u32, u32, u32, u32)> = (0..6)
			.map(|index| (20 + (index % 3) * 60, 20 + (index / 3) * 70, 40, 40))
			.collect();
		let frame = frame_with_boxes(240, 200, &boxes);
		let proposals = propose(&frame, 2);
		assert_eq!(proposals.regions.len(), 2);
		assert!(proposals.truncated, "more proposals existed than the cap");
		for region in &proposals.regions {
			assert!(region.x <= 240 && region.y <= 200);
			assert!(region.x + region.width <= 240);
			assert!(region.y + region.height <= 200);
			assert!(region.width > 0 && region.height > 0);
		}
	}

	#[test]
	fn a_box_larger_than_the_cap_is_never_returned() {
		let frame = frame_with_boxes(200, 200, &[(4, 4, 192, 192)]);
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		let frame_area = 200.0 * 200.0;
		for region in &proposals.regions {
			let area = f64::from(region.width) * f64::from(region.height);
			assert!(area < MAX_REGION_FRAME_RATIO * frame_area);
		}
	}

	#[test]
	fn full_resolution_frames_are_downsampled_before_analysis() {
		let frame = frame_with_boxes(3840, 2160, &[(1000, 800, 900, 500)]);
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		let region = proposals
			.regions
			.first()
			.expect("the card must survive downsampling");
		assert!(region.x.abs_diff(1000) <= 6, "left edge {}", region.x);
		assert!(region.y.abs_diff(800) <= 6, "top edge {}", region.y);
		assert!((region.x + region.width).abs_diff(1900) <= 6, "right edge");
	}

	#[test]
	fn cache_keeps_two_recent_frames_and_evicts_the_oldest() {
		let mut cache = FrameCache::new();
		cache.insert("first".into(), black(40, 30));
		cache.insert("second".into(), black(40, 30));
		assert_eq!(cache.len(), 2);
		assert!(cache.get("first").is_some());
		cache.insert("third".into(), black(40, 30));
		assert_eq!(cache.len(), 2);
		assert!(cache.get("first").is_none(), "the oldest frame is evicted");
		assert!(cache.get("second").is_some());
		assert!(cache.get("third").is_some());
		assert_eq!(cache.bytes(), 2 * 40 * 30);
	}

	#[test]
	fn cache_evicts_by_total_bytes_as_well_as_frame_count() {
		let mut cache = FrameCache::new();
		let big = black(4000, 3000);
		cache.insert("big".into(), big);
		cache.insert("small".into(), black(40, 30));
		assert!(cache.get("big").is_some());
		cache.insert("other".into(), black(100, 100));
		assert_eq!(cache.bytes(), 40 * 30 + 100 * 100);
		assert!(cache.get("big").is_none(), "the byte budget evicted the large frame");
	}

	#[test]
	fn a_frame_larger_than_the_whole_budget_is_not_cached() {
		let mut cache = FrameCache::new();
		let oversized = black(6000, 5000);
		assert!(oversized.as_raw().len() > MAX_CACHED_BYTES);
		cache.insert("huge".into(), oversized);
		assert!(cache.get("huge").is_none());
		assert_eq!(cache.len(), 0);
	}

	#[test]
	fn a_frame_with_too_many_components_reports_truncated() {
		// 33×33 isolated boxes: more edge structure than the component budget,
		// which is what a wallpaper, a dense canvas or a remote desktop looks like.
		let mut frame = GrayImage::from_pixel(462, 462, Luma([32]));
		for row in 0..33u32 {
			for column in 0..33u32 {
				let x = 4 + column * 14;
				let y = 4 + row * 14;
				for py in y..y + 10 {
					for px in x..x + 10 {
						frame.put_pixel(px, py, Luma([224]));
					}
				}
			}
		}
		// 64 allows all 32 row proposals, so only the component budget can mark
		// this result truncated: a regression in `components_capped` fails here.
		let proposals = propose(&frame, MAX_REGIONS);
		assert!(
			proposals.truncated,
			"the component budget is the only reason 32 proposals under a 64 cap truncate"
		);
		assert!(!proposals.regions.is_empty());
	}

	#[test]
	fn full_hd_analysis_stays_within_a_practical_budget() {
		let frame = frame_with_boxes(1920, 1200, &[(200, 150, 600, 300), (900, 600, 500, 250)]);
		let started = std::time::Instant::now();
		let proposals = propose(&frame, DEFAULT_MAX_REGIONS);
		let elapsed = started.elapsed();
		assert!(!proposals.regions.is_empty(), "the cards must survive analysis");
		println!("1920x1200 region analysis: {elapsed:?}");
		assert!(elapsed < std::time::Duration::from_secs(2), "analysis took {elapsed:?}");
	}

	#[test]
	fn luma_frame_matches_the_capture_dimensions() {
		let image = RgbaImage::from_fn(64, 48, |x, y| image::Rgba([x as u8, y as u8, 0, 255]));
		let luma = luma_frame(&image);
		assert_eq!(luma.dimensions(), (64, 48));
		assert_eq!(luma.get_pixel(0, 0)[0], 0);
	}
}
