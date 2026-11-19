//! Menu access for both Linux display servers.
//!
//! Menus are read and commanded through the frame's AT-SPI tree, so X11 and
//! Wayland share one route: the window's own menu bar is the only target, and a
//! global or detached popup is never guessed at.

use super::ax::AtSpiAx;
use crate::desktop::{
	error::CoreResult,
	menus::{DesktopMenuItem, validate_path},
	types::DesktopWindow,
};

pub(crate) fn items(
	ax: &mut AtSpiAx,
	window: &DesktopWindow,
	path: &[String],
) -> CoreResult<Vec<DesktopMenuItem>> {
	validate_path(path, true)?;
	ax.menu_items(window, path)
}

pub(crate) fn select(ax: &mut AtSpiAx, window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	ax.menu_select(window, path)
}
