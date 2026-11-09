/**
 * 统一标注 overlay —— 在**被标注的页面内部**运行的自包含脚本构建器
 * （浏览器页与会话内 HTML 卡片共用同一份实现:元素 / 区域 / 绘制三工具,
 * 圈选 + 注释,提交时一次性回发）。
 *
 * 本模块产出一段脚本字符串,经 `<webview>.executeJavaScript` 注入,或作为
 * 沙箱卡片 boot script 的一部分随 srcdoc 落地,因此它:
 *
 * - 不能 import 任何东西、不能引用宿主的主题变量(页面有自己的 `:root`);
 * - 所有颜色与文案由宿主预先解析、预先翻译后从 CONFIG 传入,这里不出现
 *   任何面向用户的硬编码;
 * - 全部 chrome 住在单个宿主元素的 **closed** shadow root 里,页面 CSS 改
 *   写不到它,页面脚本也走不进去。
 *
 * chrome 刻意分成两块而不是一整条:工具条钉在页面顶部,注释框跟随刚被
 * 标记的目标。一条钉死在某一边的整栏会盖住人们最想指的那部分页面。
 *
 * 生命周期:脚本带着 payload resolve(取消则为 null),并在 resolve 之前先
 * 拆掉自己的 chrome、等两次 repaint —— 宿主随后截到的图里只有页面和标记。
 */

export type AnnotationOverlayTheme = {
	readonly colorScheme: "light" | "dark";
	readonly primary: string;
	/** 半透明主色,已由宿主解析成具体颜色(不能靠给 hex 追加 alpha 后缀得到)。 */
	readonly primarySoft: string;
	/** 更淡的主色,用于悬停背景。 */
	readonly primaryFaint: string;
	readonly primaryContrast: string;
	readonly surface: string;
	readonly surfaceElevated: string;
	/** 半透明浮起面,对齐应用浮层的液态玻璃。 */
	readonly glassSurface: string;
	/** 现成的 `backdrop-filter` 值;主题无玻璃时为空串。 */
	readonly glassFilter: string;
	readonly border: string;
	readonly text: string;
	readonly mutedText: string;
};

/**
 * 结构化目标卡片上的文案。存在时 overlay 用卡片替代紧凑输入条;缺失时
 * 保持旧输入条(会话内 HTML 卡片仍走旧版,不因缺文案而出现空白分区)。
 */
export type AnnotationOverlayPanelLabels = {
	readonly title: string;
	readonly close: string;
	readonly sectionGeometry: string;
	readonly sectionSemantics: string;
	readonly sectionData: string;
	readonly sectionPage: string;
	readonly selector: string;
	readonly path: string;
	readonly bounds: string;
	readonly size: string;
	readonly center: string;
	readonly text: string;
	readonly styles: string;
	readonly page: string;
	readonly url: string;
	readonly viewport: string;
	readonly dpr: string;
	readonly screenshot: string;
	readonly cancel: string;
	readonly add: string;
};

export type AnnotationOverlayLabels = {
	readonly select: string;
	readonly marquee: string;
	readonly draw: string;
	readonly commentPlaceholder: string;
	readonly submit: string;
	readonly panel?: AnnotationOverlayPanelLabels;
};

const ANNOTATION_ACTIVE_FLAG = "__musepiAnnotationActive";

/** 清掉上一次会话可能遗留的 overlay。没有活动会话时调用也安全。 */
export const ANNOTATION_TEARDOWN_SCRIPT = `(() => {
  try {
    var host = document.querySelector('[data-musepi-annotation]');
    if (host && host.parentNode) host.parentNode.removeChild(host);
  } catch (error) { /* 页面已导航走 */ }
  try {
    var cursor = document.getElementById('musepi-annotation-cursor');
    if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
  } catch (error) { /* 页面已导航走 */ }
  try { delete window['${ANNOTATION_ACTIVE_FLAG}']; } catch (error) { /* non-configurable */ }
})();`;

export const buildAnnotationOverlayScript = (
	theme: AnnotationOverlayTheme,
	labels: AnnotationOverlayLabels,
	options?: { elementAt?: { x: number; y: number } },
): string => {
	const config = JSON.stringify({ theme, labels, elementAt: options?.elementAt ?? null });
	return String.raw`new Promise((resolve) => {
  var CONFIG = ${config};
  var THEME = CONFIG.theme;
  var LABELS = CONFIG.labels;
  var ELEMENT_AT = CONFIG.elementAt;
  var OVERLAY_ATTR = 'data-musepi-annotation';
  var Z_OVERLAY = 2147483646;
  var MAX_TEXT = 400;
  var MIN_RECT = 3;
  var EDITOR_GAP = 10;

  try {
    var stale = document.querySelector('[' + OVERLAY_ATTR + ']');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  } catch (error) { /* 无可清理 */ }

  window['${ANNOTATION_ACTIVE_FLAG}'] = true;

  var counter = 0;
  var nextId = function (prefix) { counter += 1; return prefix + '-' + counter; };

  var selected = null;
  var regions = [];
  var strokes = [];
  var tool = 'select';
  var settled = false;

  // ---------------------------------------------------------------- geometry

  var rectFrom = function (domRect) {
    return { x: domRect.left, y: domRect.top, width: domRect.width, height: domRect.height };
  };
  var normalizeRect = function (ax, ay, bx, by) {
    return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  };
  var usableRect = function (rect) { return rect.width >= MIN_RECT && rect.height >= MIN_RECT; };

  // ------------------------------------------------------------- description

  var isOverlayNode = function (element) {
    var node = element;
    while (node) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute(OVERLAY_ATTR)) return true;
      node = node.parentNode || (node.host || null);
    }
    return false;
  };

  var elementFromPoint = function (x, y) {
    var found = document.elementFromPoint(x, y);
    if (!found || isOverlayNode(found)) return null;
    return found;
  };

  var selectorPart = function (element) {
    var part = element.tagName.toLowerCase();
    if (element.id) return part + '#' + element.id;
    var className = typeof element.className === 'string' ? element.className.trim() : '';
    if (className) {
      var first = className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (first) part += '.' + first;
    }
    return part;
  };

  var buildSelector = function (element) {
    if (element.id) return '#' + element.id;
    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var part = selectorPart(node);
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName;
        });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id) break;
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  var INTERESTING_ATTRS = ['id', 'class', 'name', 'type', 'href', 'src', 'alt', 'title', 'role', 'placeholder', 'aria-label', 'data-testid'];
  var STYLE_PROPS = [
    'display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
    'lineHeight', 'padding', 'margin', 'border', 'borderRadius', 'width', 'height', 'opacity',
    'zIndex', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'textAlign'
  ];

  var describe = function (element) {
    var computed = window.getComputedStyle(element);
    var attributes = {};
    for (var i = 0; i < INTERESTING_ATTRS.length; i += 1) {
      var name = INTERESTING_ATTRS[i];
      var value = element.getAttribute(name);
      if (value) attributes[name] = String(value).slice(0, 200);
    }
    // data-* 没有固定名单,但"页面把这些值写进了 DOM"往往正是改动依据。
    var dataCount = 0;
    for (var d = 0; d < element.attributes.length && dataCount < 40; d += 1) {
      var attribute = element.attributes[d];
      if (attribute.name.indexOf('data-') !== 0) continue;
      attributes[attribute.name] = String(attribute.value).slice(0, 200);
      dataCount += 1;
    }
    var computedStyle = {};
    for (var j = 0; j < STYLE_PROPS.length; j += 1) {
      var prop = STYLE_PROPS[j];
      computedStyle[prop] = String(computed[prop] == null ? '' : computed[prop]);
    }
    var ancestry = [];
    var node = element.parentElement;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      var entry = { tag: node.tagName.toLowerCase(), selectorPart: selectorPart(node) };
      if (node.id) entry.id = node.id;
      var cls = typeof node.className === 'string' ? node.className.trim() : '';
      if (cls) entry.className = cls.slice(0, 200);
      ancestry.unshift(entry);
      node = node.parentElement;
      depth += 1;
    }
    var box = element.getBoundingClientRect();
    var text = (element.textContent == null ? '' : String(element.textContent)).replace(/\s+/g, ' ').trim();
    return {
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, MAX_TEXT),
      selector: buildSelector(element),
      path: ancestry.map(function (e) { return e.selectorPart; }).concat([selectorPart(element)]).join(' > '),
      bounds: rectFrom(box),
      center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      attributes: attributes,
      computedStyle: computedStyle,
      ancestry: ancestry
    };
  };

  // ------------------------------------------------------------------ chrome

  var host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  // 手动 popover:show 之后进入浏览器 top layer,同时不让页面其余部分 inert。
  host.setAttribute('popover', 'manual');
  // 每条声明都带 !important:作为 popover、以及后来落进页面 dialog 时,
  // 宿主会命中页面自己的规则(如 [popover]{background:...}),那会把整页
  // 涂成一张幕布。
  host.style.cssText = [
    'all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:auto', 'height:auto',
    'max-width:none', 'max-height:none', 'margin:0', 'padding:0', 'border:0', 'background:transparent',
    'overflow:visible', 'opacity:1', 'transform:none', 'z-index:' + Z_OVERLAY, 'pointer-events:none'
  ].join(' !important;') + ' !important';
  var shadow = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.layer{position:fixed;inset:0;pointer-events:none}',
    '.box{position:fixed;left:0;top:0;display:none;pointer-events:none;border:1.5px solid ' + THEME.primary + ';background:' + THEME.primarySoft + ';border-radius:2px}',
    // Element-hover box eases from one target rect to the next; marquee and
    // selected outlines use the same .box but stay instant / stable.
    '.box--morph{transition:transform 110ms cubic-bezier(.22,1,.36,1),width 110ms cubic-bezier(.22,1,.36,1),height 110ms cubic-bezier(.22,1,.36,1);will-change:transform,width,height}',
    '@media (prefers-reduced-motion: reduce){.box--morph{transition:none}}',
    '.label{position:fixed;left:0;top:0;display:none;pointer-events:none;padding:1px 6px;border-radius:4px;background:' + THEME.primary + ';color:' + THEME.primaryContrast + ';font-size:11px;line-height:17px;white-space:nowrap;font-weight:600}',
    '.tools{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:4px;border-radius:999px;border:1px solid ' + THEME.border + ';background:' + THEME.glassSurface + ';-webkit-backdrop-filter:' + THEME.glassFilter + ';backdrop-filter:' + THEME.glassFilter + ';box-shadow:0 6px 20px rgba(0,0,0,.24);pointer-events:auto}',
    '.tools button{appearance:none;border:none;background:transparent;color:' + THEME.mutedText + ';border-radius:999px;padding:5px 14px;font-size:12px;line-height:18px;font-weight:500;cursor:pointer;white-space:nowrap}',
    '.tools button:hover{background:' + THEME.primaryFaint + '}',
    '.tools button[aria-pressed="true"]{background:' + THEME.primarySoft + ';color:' + THEME.primary + ';font-weight:600}',
    '.editor{position:fixed;left:0;top:0;display:none;align-items:center;gap:8px;width:min(420px,calc(100vw - 24px));padding:6px;padding-left:16px;border-radius:22px;border:1px solid ' + THEME.border + ';background:' + THEME.glassSurface + ';-webkit-backdrop-filter:' + THEME.glassFilter + ';backdrop-filter:' + THEME.glassFilter + ';box-shadow:0 8px 28px rgba(0,0,0,.3);pointer-events:auto}',
    '.editor textarea{flex:1;min-width:0;resize:none;border:none;background:transparent;color:' + THEME.text + ';font-size:13px;line-height:20px;outline:none;padding:6px 0;min-height:32px;max-height:104px;display:block}',
    '.editor textarea::placeholder{color:' + THEME.mutedText + '}',
    '.editor button{appearance:none;border:none;background:' + THEME.primary + ';color:' + THEME.primaryContrast + ';border-radius:999px;width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer}',
    '.editor button svg{width:16px;height:16px;display:block}',
    '.editor button[disabled]{opacity:.5;cursor:default}',
    // 结构化目标卡片:同一份 chrome,给"选中元素"提供可折叠的结构信息。
    '.panel{position:fixed;left:0;top:0;display:none;flex-direction:column;width:min(360px,calc(100vw - 16px));max-height:min(480px,calc(100vh - 16px));border-radius:16px;border:1px solid ' + THEME.border + ';background:' + THEME.surfaceElevated + ';box-shadow:0 18px 48px rgba(0,0,0,.38);pointer-events:auto;overflow:hidden;color:' + THEME.text + '}',
    '.panel [hidden]{display:none !important}',
    '.panel-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 14px;border-bottom:1px solid ' + THEME.border + ';flex-shrink:0}',
    '.panel-id{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden;font-size:12px;line-height:18px}',
    '.panel-tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;color:' + THEME.primary + ';white-space:nowrap}',
    '.panel-classes{color:' + THEME.mutedText + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.panel-close{appearance:none;border:none;background:transparent;color:' + THEME.mutedText + ';width:26px;height:26px;padding:0;border-radius:999px;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer}',
    '.panel-close:hover{background:' + THEME.primaryFaint + ';color:' + THEME.text + '}',
    '.panel-close svg{width:14px;height:14px;display:block}',
    '.panel-scroll{overflow:auto;overscroll-behavior:contain;flex:1 1 auto;min-height:0;padding:2px 0}',
    '.panel-section{border-bottom:1px solid ' + THEME.border + '}',
    '.panel-section:last-child{border-bottom:none}',
    '.panel-section-head{appearance:none;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:none;background:transparent;color:' + THEME.mutedText + ';padding:8px 14px;font-size:11px;line-height:16px;font-weight:600;cursor:pointer;text-align:left}',
    '.panel-section-head:hover{background:' + THEME.primaryFaint + '}',
    '.panel-chevron{font-size:10px;line-height:1;transition:transform 120ms ease}',
    '.panel-section-head[aria-expanded="false"] .panel-chevron{transform:rotate(-90deg)}',
    '@media (prefers-reduced-motion: reduce){.panel-chevron{transition:none}}',
    '.panel-rows{display:grid;gap:5px;padding:0 14px 10px}',
    '.panel-row{display:grid;grid-template-columns:minmax(56px,auto) minmax(0,1fr);gap:10px;font-size:11px;line-height:16px}',
    '.panel-key{color:' + THEME.mutedText + '}',
    '.panel-val{color:' + THEME.text + ';font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}',
    '.panel-val--text{font-family:inherit}',
    '.panel-foot{display:flex;flex-direction:column;gap:8px;padding:10px 14px 12px;border-top:1px solid ' + THEME.border + ';flex-shrink:0}',
    '.panel textarea{width:100%;resize:none;border:1px solid ' + THEME.border + ';border-radius:10px;background:transparent;color:' + THEME.text + ';font-size:12.5px;line-height:18px;outline:none;padding:7px 9px;min-height:34px;max-height:104px;display:block}',
    '.panel textarea::placeholder{color:' + THEME.mutedText + '}',
    '.panel textarea:focus{border-color:' + THEME.primary + '}',
    '.panel-toggle{display:flex;align-items:center;gap:7px;font-size:11.5px;line-height:16px;color:' + THEME.mutedText + ';cursor:pointer;user-select:none}',
    '.panel-toggle input{width:14px;height:14px;margin:0;accent-color:' + THEME.primary + ';cursor:pointer;flex-shrink:0}',
    '.panel-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.panel-actions button{appearance:none;border-radius:999px;font-size:12px;line-height:18px;font-weight:600;padding:6px 14px;cursor:pointer;white-space:nowrap}',
    '.panel-cancel{border:1px solid ' + THEME.border + ';background:transparent;color:' + THEME.text + '}',
    '.panel-cancel:hover{background:' + THEME.primaryFaint + '}',
    '.panel-add{border:none;background:' + THEME.primary + ';color:' + THEME.primaryContrast + '}',
    '.panel-add[disabled]{opacity:.5;cursor:default}'
  ].join('');
  shadow.appendChild(style);

  var cursorStyle = document.createElement('style');
  cursorStyle.id = 'musepi-annotation-cursor';
  document.head.appendChild(cursorStyle);
  var setCursor = function (value) {
    cursorStyle.textContent = value ? '*{cursor:' + value + ' !important}' : '';
  };

  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'layer');
  svg.style.overflow = 'visible';
  shadow.appendChild(svg);

  var hoverBox = document.createElement('div');
  hoverBox.className = 'box box--morph';
  var hoverLabel = document.createElement('div');
  hoverLabel.className = 'label';
  var marqueeBox = document.createElement('div');
  marqueeBox.className = 'box';
  shadow.append(hoverBox, hoverLabel, marqueeBox);

  var positionBox = function (node, rect) {
    node.style.display = 'block';
    node.style.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px)';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
  };

  var tools = document.createElement('div');
  tools.className = 'tools';
  shadow.appendChild(tools);

  var toolButtons = {};
  [['select', LABELS.select], ['marquee', LABELS.marquee], ['draw', LABELS.draw]].forEach(function (entry) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry[1];
    button.addEventListener('click', function () { setTool(entry[0]); });
    toolButtons[entry[0]] = button;
    tools.appendChild(button);
  });

  var PANEL = LABELS.panel || null;
  var includeScreenshot = true;
  var collapsedSections = {};

  var comment = document.createElement('textarea');
  comment.rows = 1;
  comment.placeholder = LABELS.commentPlaceholder;

  var editor;
  var submit;
  var panelHead = null;
  var panelIdentity = null;
  var panelSections = null;
  var geometryRefs = null;

  var createSubmit = function (className) {
    var button = document.createElement('button');
    button.type = 'button';
    if (className) button.className = className;
    // attach 在脚本末尾才赋值,包装一层按调用时解析。
    button.addEventListener('click', function () { attach(); });
    return button;
  };

  if (PANEL) {
    editor = document.createElement('div');
    editor.className = 'panel';
    editor.setAttribute('role', 'dialog');
    editor.setAttribute('aria-modal', 'false');
    editor.setAttribute('aria-label', PANEL.title);

    panelHead = document.createElement('div');
    panelHead.className = 'panel-head';
    panelIdentity = document.createElement('div');
    panelIdentity.className = 'panel-id';
    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'panel-close';
    closeButton.setAttribute('aria-label', PANEL.close);
    closeButton.title = PANEL.close;
    closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z" fill="currentColor"/></svg>';
    closeButton.addEventListener('click', function () { dropSelection(); syncChrome(); });
    panelHead.append(panelIdentity, closeButton);

    panelSections = document.createElement('div');
    panelSections.className = 'panel-scroll';

    var foot = document.createElement('div');
    foot.className = 'panel-foot';

    var toggleLabel = document.createElement('label');
    toggleLabel.className = 'panel-toggle';
    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = includeScreenshot;
    toggle.addEventListener('change', function () { includeScreenshot = toggle.checked; });
    var toggleText = document.createElement('span');
    toggleText.textContent = PANEL.screenshot;
    toggleLabel.append(toggle, toggleText);

    var actions = document.createElement('div');
    actions.className = 'panel-actions';
    var cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'panel-cancel';
    cancelButton.textContent = PANEL.cancel;
    cancelButton.addEventListener('click', function () { finish(null); });
    submit = createSubmit('panel-add');
    submit.textContent = PANEL.add;
    actions.append(cancelButton, submit);

    foot.append(comment, toggleLabel, actions);
    editor.append(panelHead, panelSections, foot);
  } else {
    editor = document.createElement('div');
    editor.className = 'editor';
    submit = createSubmit(null);
    // 纯图标附加按钮,与聊天注释输入一致;本地化标签留给无障碍。
    submit.setAttribute('aria-label', LABELS.submit);
    submit.title = LABELS.submit;
    submit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.8287 7.75737L9.1718 13.4142C8.78127 13.8047 8.78127 14.4379 9.1718 14.8284C9.56232 15.219 10.1955 15.219 10.586 14.8284L16.2429 9.17158C17.4144 8.00001 17.4144 6.10052 16.2429 4.92894C15.0713 3.75737 13.1718 3.75737 12.0002 4.92894L6.34337 10.5858C4.39075 12.5384 4.39075 15.7042 6.34337 17.6569C8.29599 19.6095 11.4618 19.6095 13.4144 17.6569L19.0713 12L20.4855 13.4142L14.8287 19.0711C12.095 21.8047 7.66283 21.8047 4.92916 19.0711C2.19549 16.3374 2.19549 11.9053 4.92916 9.17158L10.586 3.51473C12.5386 1.56211 15.7045 1.56211 17.6571 3.51473C19.6097 5.46735 19.6097 8.63317 17.6571 10.5858L12.0002 16.2427C10.8287 17.4142 8.92916 17.4142 7.75759 16.2427C6.58601 15.0711 6.58601 13.1716 7.75759 12L13.4144 6.34316L14.8287 7.75737Z" fill="currentColor"/></svg>';
    editor.append(comment, submit);
  }
  shadow.appendChild(editor);

  // ------------------------------------------------------------ panel content

  var formatBounds = function (rect) {
    return 'x ' + Math.round(rect.x) + ', y ' + Math.round(rect.y) + ', w ' + Math.round(rect.width) + ', h ' + Math.round(rect.height);
  };
  var formatSize = function (rect) {
    return Math.round(rect.width) + ' × ' + Math.round(rect.height);
  };
  var addRow = function (parent, label, value, mono, refKey) {
    var text = value == null ? '' : String(value);
    if (!text) return;
    var row = document.createElement('div');
    row.className = 'panel-row';
    var key = document.createElement('span');
    key.className = 'panel-key';
    key.textContent = label;
    var val = document.createElement('span');
    val.className = mono === false ? 'panel-val panel-val--text' : 'panel-val';
    val.textContent = text;
    if (refKey && geometryRefs) geometryRefs[refKey] = val;
    row.append(key, val);
    parent.appendChild(row);
  };
  var addSection = function (key, title, fill) {
    var section = document.createElement('div');
    section.className = 'panel-section';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'panel-section-head';
    var expanded = !collapsedSections[key];
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    var label = document.createElement('span');
    label.textContent = title;
    var chevron = document.createElement('span');
    chevron.className = 'panel-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '▾';
    head.append(label, chevron);
    var body = document.createElement('div');
    body.className = 'panel-rows';
    body.hidden = !expanded;
    fill(body);
    head.addEventListener('click', function () {
      var next = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      body.hidden = !next;
      collapsedSections[key] = !next;
      // 折叠改变高度,重新贴回目标旁边。
      positionEditor();
    });
    section.append(head, body);
    panelSections.appendChild(section);
  };

  var renderIdentity = function (target) {
    panelIdentity.textContent = '';
    var tag = document.createElement('span');
    tag.className = 'panel-tag';
    tag.textContent = target.tag + (target.attributes.id ? '#' + target.attributes.id : '');
    panelIdentity.appendChild(tag);
    var classes = String(target.attributes.class || '').split(/\s+/).filter(Boolean).slice(0, 4);
    if (classes.length === 0) return;
    var cls = document.createElement('span');
    cls.className = 'panel-classes';
    cls.textContent = classes.map(function (name) { return '.' + name; }).join('');
    cls.title = target.attributes.class;
    panelIdentity.appendChild(cls);
  };

  var SEMANTIC_ATTRS = ['role', 'aria-label', 'title', 'alt', 'name', 'type', 'href', 'src', 'placeholder'];
  var styleSummary = function (styles) {
    var parts = [];
    if (styles.display) parts.push('display: ' + styles.display);
    if (styles.position) parts.push('position: ' + styles.position);
    var font = [styles.fontWeight, styles.fontSize].filter(Boolean).join(' ');
    if (font) parts.push('font: ' + font + (styles.lineHeight ? ' / ' + styles.lineHeight : ''));
    if (styles.color) parts.push('color: ' + styles.color);
    if (styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') parts.push('background: ' + styles.backgroundColor);
    if (styles.opacity && styles.opacity !== '1') parts.push('opacity: ' + styles.opacity);
    return parts.join('; ');
  };

  var renderGeometry = function (body, target) {
    addRow(body, PANEL.selector, target.selector, true);
    addRow(body, PANEL.path, target.path, true);
    addRow(body, PANEL.bounds, formatBounds(target.bounds), true, 'bounds');
    addRow(body, PANEL.size, formatSize(target.bounds), true, 'size');
    addRow(body, PANEL.center, 'x ' + Math.round(target.center.x) + ', y ' + Math.round(target.center.y), true, 'center');
  };

  var renderSemantics = function (body, target) {
    addRow(body, PANEL.text, target.text, false);
    SEMANTIC_ATTRS.forEach(function (name) {
      if (target.attributes[name]) addRow(body, name, target.attributes[name], false);
    });
    addRow(body, PANEL.styles, styleSummary(target.computedStyle), false);
  };

  var renderData = function (body, target) {
    Object.keys(target.attributes)
      .filter(function (name) { return name.indexOf('data-') === 0; })
      .sort()
      .forEach(function (name) { addRow(body, name, target.attributes[name], true); });
  };

  var renderPage = function (body) {
    addRow(body, PANEL.page, document.title || String(location.href), false);
    addRow(body, PANEL.url, String(location.href), true);
    addRow(body, PANEL.viewport, window.innerWidth + ' × ' + window.innerHeight, true);
    addRow(body, PANEL.dpr, String(window.devicePixelRatio || 1), true);
  };

  /** 区域与笔迹标的是"这块地方",卡片只给几何,不装成元素语义。 */
  var renderMarks = function (body) {
    regions.forEach(function (entry, index) {
      addRow(body, LABELS.marquee + ' ' + (index + 1), formatBounds(entry.rect) + ' · ' + formatSize(entry.rect), true);
    });
    strokes.forEach(function (entry, index) {
      addRow(body, LABELS.draw + ' ' + (index + 1), formatBounds(entry.bounds) + ' · ' + formatSize(entry.bounds), true);
    });
  };

  var renderSections = function () {
    if (!PANEL) return;
    geometryRefs = {};
    panelSections.textContent = '';
    if (!selected) {
      panelHead.hidden = true;
      addSection('geometry', PANEL.sectionGeometry, renderMarks);
      return;
    }
    panelHead.hidden = false;
    renderIdentity(selected.description);
    addSection('geometry', PANEL.sectionGeometry, function (body) { renderGeometry(body, selected.description); });
    addSection('semantics', PANEL.sectionSemantics, function (body) { renderSemantics(body, selected.description); });
    var dataNames = Object.keys(selected.description.attributes).filter(function (name) {
      return name.indexOf('data-') === 0;
    });
    if (dataNames.length > 0) {
      addSection('data', PANEL.sectionData, function (body) { renderData(body, selected.description); });
    }
    addSection('page', PANEL.sectionPage, renderPage);
  };

  /** 滚动时元素的盒变了,几何行的值得跟着更新;语义/属性不用重算。 */
  var refreshGeometry = function () {
    if (!geometryRefs || !selected) return;
    var bounds = selected.description.bounds;
    if (geometryRefs.bounds) geometryRefs.bounds.textContent = formatBounds(bounds);
    if (geometryRefs.size) geometryRefs.size.textContent = formatSize(bounds);
    if (geometryRefs.center) geometryRefs.center.textContent = 'x ' + Math.round(selected.description.center.x) + ', y ' + Math.round(selected.description.center.y);
  };

  /** 输入框随内容长高。隐藏元素的 scrollHeight 是 0,量它会塌缩;只在
   *  可见时量、且不低于 CSS min-height。 */
  var resizeComment = function () {
    if (editor.style.display === 'none') return;
    comment.style.height = 'auto';
    comment.style.height = Math.max(32, Math.min(comment.scrollHeight, 104)) + 'px';
  };
  comment.addEventListener('input', resizeComment);

  // -------------------------------------------------------------- selection

  var lastTargetRect = null;

  /** 注释框放在刚标记的目标下方,并始终保持在屏幕内。 */
  var positionEditor = function () {
    if (!lastTargetRect) {
      editor.style.display = 'none';
      return;
    }
    var wasHidden = editor.style.display === 'none';
    editor.style.display = 'flex';
    // 现在已排版完成再量,别在它还藏着的时候量。
    if (wasHidden) resizeComment();
    var box = editor.getBoundingClientRect();
    var left = lastTargetRect.x + lastTargetRect.width / 2 - box.width / 2;
    var top = lastTargetRect.y + lastTargetRect.height + EDITOR_GAP;
    // 下方没空间时翻到目标上方,盒子不会被留半截在页面底外。
    if (top + box.height > window.innerHeight - 8) {
      var above = lastTargetRect.y - box.height - EDITOR_GAP;
      top = above >= 8 ? above : window.innerHeight - box.height - 8;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8));
    editor.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  };

  /** 排版后再聚焦:给一个零高度输入框聚焦,光标落在不知哪里。 */
  var focusComment = function () {
    requestAnimationFrame(function () {
      try {
        comment.focus({ preventScroll: true });
        comment.setSelectionRange(comment.value.length, comment.value.length);
      } catch (error) { /* 输入框已没了 */ }
    });
  };

  var hasTargets = function () {
    return Boolean(selected) || regions.length > 0 || strokes.length > 0;
  };

  var syncChrome = function () {
    submit.disabled = !hasTargets();
    if (!hasTargets()) {
      lastTargetRect = null;
      editor.style.display = 'none';
      return;
    }
    renderSections();
    positionEditor();
  };

  var syncSelectionVisuals = function () {
    if (!selected) return;
    var rect = rectFrom(selected.element.getBoundingClientRect());
    selected.description.bounds = rect;
    selected.description.center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    refreshGeometry();
    if (!usableRect(rect)) {
      selected.outline.style.display = 'none';
      selected.badge.style.display = 'none';
      return;
    }
    positionBox(selected.outline, rect);
    selected.badge.style.display = 'block';
    selected.badge.style.transform = 'translate(' + Math.max(2, rect.x) + 'px,' + Math.max(2, rect.y - 19) + 'px)';
    lastTargetRect = rect;
  };

  var dropSelection = function () {
    if (!selected) return;
    selected.outline.remove();
    selected.badge.remove();
    selected = null;
  };

  var selectElement = function (element) {
    var wasSelected = selected && selected.element === element;
    dropSelection();
    if (wasSelected) {
      // 再点一次已选元素即取消:误点一次只花一次点击,不用重来。
      lastTargetRect = null;
      syncChrome();
      return;
    }
    var outline = document.createElement('div');
    outline.className = 'box';
    var badge = document.createElement('div');
    badge.className = 'label';
    badge.textContent = selectorPart(element);
    shadow.append(outline, badge);
    selected = { id: nextId('element'), element: element, description: describe(element), outline: outline, badge: badge };
    syncSelectionVisuals();
    syncChrome();
    focusComment();
  };

  var setTool = function (next) {
    tool = next;
    hoverBox.style.display = 'none';
    hoverLabel.style.display = 'none';
    marqueeBox.style.display = 'none';
    setCursor(next === 'select' ? '' : 'crosshair');
    for (var key in toolButtons) {
      if (Object.prototype.hasOwnProperty.call(toolButtons, key)) {
        toolButtons[key].setAttribute('aria-pressed', key === next ? 'true' : 'false');
      }
    }
  };

  // ------------------------------------------------------------- interaction

  var drag = null;

  var onPointerMove = function (event) {
    if (drag) {
      if (drag.kind === 'marquee') {
        drag.rect = normalizeRect(drag.startX, drag.startY, event.clientX, event.clientY);
        positionBox(marqueeBox, drag.rect);
      } else if (drag.kind === 'draw') {
        drag.points.push({ x: event.clientX, y: event.clientY });
        drag.path.setAttribute('d', drag.points.map(function (point, index) {
          return (index === 0 ? 'M' : 'L') + point.x + ' ' + point.y;
        }).join(' '));
      }
      return;
    }

    if (tool !== 'select') return;
    var element = elementFromPoint(event.clientX, event.clientY);
    if (!element) {
      hoverBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      return;
    }
    var rect = rectFrom(element.getBoundingClientRect());
    positionBox(hoverBox, rect);
    hoverLabel.textContent = selectorPart(element);
    hoverLabel.style.display = 'block';
    hoverLabel.style.transform = 'translate(' + Math.max(2, rect.x) + 'px,' + Math.max(2, rect.y - 19) + 'px)';
  };

  var onPointerDown = function (event) {
    if (event.button !== 0) return;
    if (isOverlayNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();

    if (tool === 'select') {
      var element = elementFromPoint(event.clientX, event.clientY);
      if (element) selectElement(element);
      return;
    }

    if (tool === 'marquee') {
      drag = { kind: 'marquee', startX: event.clientX, startY: event.clientY, rect: null };
      return;
    }

    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', THEME.primary);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    drag = { kind: 'draw', path: path, points: [{ x: event.clientX, y: event.clientY }] };
  };

  var onPointerUp = function () {
    if (!drag) return;
    var finished = drag;
    drag = null;

    if (finished.kind === 'marquee') {
      marqueeBox.style.display = 'none';
      var rect = finished.rect;
      if (!rect || !usableRect(rect)) return;
      // 区域标记的是"这块地方",不是里面的元素:把它展开成选择集会让结果
      // 依赖页面 markup,而不是你框住的那块画面。
      regions.push({ id: nextId('region'), rect: rect });
      var outline = document.createElementNS(svgNS, 'rect');
      outline.setAttribute('x', String(rect.x));
      outline.setAttribute('y', String(rect.y));
      outline.setAttribute('width', String(rect.width));
      outline.setAttribute('height', String(rect.height));
      outline.style.fill = THEME.primarySoft;
      outline.setAttribute('stroke', THEME.primary);
      outline.setAttribute('stroke-width', '1.5');
      outline.setAttribute('rx', '2');
      svg.appendChild(outline);
      lastTargetRect = rect;
      syncChrome();
      focusComment();
      return;
    }

    var points = finished.points;
    if (points.length < 2) {
      if (finished.path.parentNode) finished.path.parentNode.removeChild(finished.path);
      return;
    }
    var minX = points[0].x, minY = points[0].y, maxX = points[0].x, maxY = points[0].y;
    for (var p = 1; p < points.length; p += 1) {
      minX = Math.min(minX, points[p].x);
      minY = Math.min(minY, points[p].y);
      maxX = Math.max(maxX, points[p].x);
      maxY = Math.max(maxY, points[p].y);
    }
    var bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    strokes.push({ id: nextId('stroke'), points: points, bounds: bounds });
    lastTargetRect = bounds;
    syncChrome();
    focusComment();
  };

  /** 标注期间吞掉页面自己的鼠标处理。只挡 pointerdown 不够:click 仍会跟上,
   *  标个按钮就把按钮按了、标个链接就导航走了。这些事件是会到达页面代码的,
   *  所以必须在这里停住。 */
  var blockPageInteraction = function (event) {
    if (isOverlayNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  var BLOCKED_EVENTS = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'contextmenu'];

  var onScrollOrResize = function () {
    syncSelectionVisuals();
    positionEditor();
  };

  var onKeyDown = function (event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    }
  };

  var onCommentKeyDown = function (event) {
    // 别让被标注的页面把敲进去的字母当成自己的快捷键。
    event.stopPropagation();
    // WebKit 会把输入法确认的回车报成 keyCode 229。
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      attach();
    }
  };

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  BLOCKED_EVENTS.forEach(function (name) {
    window.addEventListener(name, blockPageInteraction, { capture: true, passive: false });
  });
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);
  window.addEventListener('keydown', onKeyDown, true);
  comment.addEventListener('keydown', onCommentKeyDown);

  // --------------------------------------------------------------- top layer

  /** 让 chrome 始终压在页面弹出的 modal dialog / popover 之上。
   *
   *  那些东西渲染在浏览器 top layer,任何 z-index 都够不着;modal dialog
   *  还会让自身之外的一切 inert:轮廓画在 dialog 下面,注释框打不了字。所以
   *  宿主以 popover 形式 show(同样进 top layer),并住进页面最上层的 modal
   *  dialog 里 —— 那里没有 inert。页面把新东西压上来时重新 show 一次,保持在
   *  最后(即最上)。
   *
   *  自己开一个 modal dialog 反而会把页面的 dialog 弄 inert —— 那正是被
   *  标注的对象。 */
  var modals = [];

  var isModalDialog = function (element) {
    if (element.tagName !== 'DIALOG') return false;
    try { return element.matches(':modal'); } catch (error) { return false; }
  };

  var trackDialog = function (dialog) {
    var index = modals.indexOf(dialog);
    if (index !== -1) modals.splice(index, 1);
    // 后开的压栈顶。标注开始时已打开的 dialog 按文档序收进,即常规嵌套序。
    if (isModalDialog(dialog)) modals.push(dialog);
  };

  var topModal = function () {
    for (var i = modals.length - 1; i >= 0; i -= 1) {
      if (modals[i].isConnected && isModalDialog(modals[i])) return modals[i];
    }
    return null;
  };

  var placeHost = function () {
    var parent = topModal() || document.body || document.documentElement;
    // 搬动宿主会让卡片里的焦点(评论框、分区按钮、开关)在打字中途丢掉。
    var focused = shadow.activeElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (error) { /* 无 popover 支持:z-index 仍能盖住普通页面 */ }
    if (focused && typeof focused.focus === 'function') focused.focus({ preventScroll: true });
  };

  var topLayerObserver = new window.MutationObserver(function (records) {
    var changed = false;
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].type === 'attributes' && records[i].target.tagName === 'DIALOG') {
        trackDialog(records[i].target);
        changed = true;
      }
    }
    if (!host.isConnected) {
      // 被有意移除(不是随 dialog 一起):会话被应用侧取消或被新会话替换。
      // 结束它,监听器别再吞页面点击,也没有谁会再把宿主拉回来。
      for (var j = 0; j < records.length; j += 1) {
        if (Array.prototype.indexOf.call(records[j].removedNodes, host) !== -1) {
          finish(null);
          return;
        }
      }
      changed = true;
    }
    if (!changed) return;
    placeHost();
    // 我们自己的搬动不算页面变化。
    topLayerObserver.takeRecords();
  });

  var onToggle = function (event) {
    if (event.target === host || event.newState !== 'open') return;
    placeHost();
    topLayerObserver.takeRecords();
  };

  // 宿主住在页面 dialog 里时,点在 chrome 上的事件会到达 dialog 自己的
  // 处理器,点在框外的点击常会把它关掉;注释框打字同样会漏给它的按键
  // 处理器。这两样都停住。
  var CHROME_EVENTS = BLOCKED_EVENTS.concat([
    'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input'
  ]);
  var keepChromeEvent = function (event) { event.stopPropagation(); };
  CHROME_EVENTS.forEach(function (name) {
    host.addEventListener(name, keepChromeEvent);
  });

  var startTopLayer = function () {
    Array.prototype.forEach.call(document.querySelectorAll('dialog'), trackDialog);
    placeHost();
    topLayerObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open']
    });
    document.addEventListener('toggle', onToggle, true);
  };

  // ------------------------------------------------------------------ finish

  var teardown = function () {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    BLOCKED_EVENTS.forEach(function (name) {
      window.removeEventListener(name, blockPageInteraction, true);
    });
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('keydown', onKeyDown, true);
    comment.removeEventListener('keydown', onCommentKeyDown);
    topLayerObserver.disconnect();
    document.removeEventListener('toggle', onToggle, true);
    setCursor('');
    if (cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle);
    if (host.parentNode) host.parentNode.removeChild(host);
    try { delete window['${ANNOTATION_ACTIVE_FLAG}']; } catch (error) { /* non-configurable */ }
  };

  var finish = function (payload) {
    if (settled) return;
    settled = true;
    teardown();
    // 只删 chrome 不够:宿主随后就截图,合成器可能还握着一帧带轮廓的。
    // 让出两帧,让页面真的重绘完。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resolve(payload); });
    });
  };

  var attach = function () {
    if (!hasTargets()) return;
    finish({
      id: 'annotation-' + Date.now(),
      pageUrl: String(location.href),
      pageTitle: String(document.title || ''),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio || 1,
      comment: comment.value,
      includeScreenshot: includeScreenshot,
      // 元素至多一个,绝不更多。保持列表形态,让元素/区域/笔迹对下游
      // 始终是同一个形状。
      elements: selected ? [{ id: selected.id, element: describe(selected.element) }] : [],
      regions: regions.map(function (entry) { return { id: entry.id, rect: entry.rect }; }),
      strokes: strokes.map(function (entry) {
        return { id: entry.id, points: entry.points, bounds: entry.bounds };
      })
    });
  };

  startTopLayer();
  setTool('select');
  syncChrome();
  // Context-menu entry: the pointer already names the element, so open its
  // structured card immediately instead of asking for a second selection.
  if (ELEMENT_AT) {
    var initialElement = elementFromPoint(ELEMENT_AT.x, ELEMENT_AT.y);
    if (initialElement) selectElement(initialElement);
  }
})`;
};
