/**
 * Composer「性能与用量」的 简洁/详细 偏好常量。
 *
 * 读数行本身由 bundled 插件提供（`packages/coding-agent/src/bundled-plugins/
 * stats-pills`，座位 `composer.dock`），宿主不再渲染这一行。这里只留下
 * 设置页与插件共用的两个常量：同一个 localStorage 键、同一个通知事件，
 * 所以在哪边切换都同帧生效。
 */

export const STATS_MODE_KEY = "musepi-gui-stats-mode";
export const STATS_MODE_EVENT = "musepi-stats-mode-changed";
