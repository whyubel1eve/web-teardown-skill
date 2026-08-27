/**
 * web-teardown · 提取器
 *
 * 三条采集通道共用的唯一真相源。跑在目标页面的 JS 上下文里，
 * 只读 CSSOM 和 getComputedStyle —— 不截图，不需要任何多模态能力。
 *
 * 用法：注入本文件后调用 __TEARDOWN__(opts)，返回一个普通对象。
 *   opts.maxElements  最多遍历多少个元素（默认 20000）
 *   opts.topN         每类频次表保留多少项（默认 40）
 */
(function () {
  'use strict';

  // ── 颜色 ────────────────────────────────────────────────────
  function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

  function rgbToOklch(r, g, b) {
    var lr = srgbToLin(r / 255), lg = srgbToLin(g / 255), lb = srgbToLin(b / 255);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    var C = Math.sqrt(A * A + B * B);
    var H = Math.atan2(B, A) * 180 / Math.PI; if (H < 0) H += 360;
    // 彩度低到这个程度时色相是数值噪音，标成 null 比报一个假角度诚实
    return { L: +(L * 100).toFixed(1), C: +C.toFixed(4), H: C < 0.0008 ? null : +H.toFixed(1) };
  }

  /**
   * 颜色归一化。
   *
   * 不能只认 rgb() —— 现代站点的 computed style 会直接返回 lab() / oklch() /
   * color(display-p3 …)。Tailwind v4 全站都是 lab()，只匹配 rgb 的话色板会整个变空。
   *
   * 所以：常见的 rgb() 走正则快路径，其余一律丢给 canvas 归一化 ——
   * 浏览器认得的格式它全认，不用我们跟着 CSS Color 规范追。
   * 代价是超出 sRGB 的广色域色会被夹回来，对出色板来说可以接受。
   */
  var _ctx = null, _memo = {};
  function rgbaFromString(s) {
    var q = s.match(/rgba?\(([^)]+)\)/);
    if (!q) return null;
    var v = q[1].split(/[,\s\/]+/).filter(Boolean).map(parseFloat);
    if (v.length < 3 || v.slice(0, 3).some(isNaN)) return null;
    var a = v.length > 3 ? v[3] : 1;
    return a === 0 ? null : { r: v[0], g: v[1], b: v[2], a: a };
  }

  function parseColor(str) {
    if (str == null || str === '') return null;
    var s = String(str).trim();
    if (s === 'transparent' || s === 'none' || s === 'currentcolor') return null;
    if (Object.prototype.hasOwnProperty.call(_memo, s)) return _memo[s];

    // 快路径：绝大多数 computed style 还是 rgb()/rgba()
    var out = /^rgba?\(/i.test(s) ? rgbaFromString(s) : null;

    if (!out && /^(#|[a-z]+\()/i.test(s)) {
      try {
        if (!_ctx) {
          var cvs = document.createElement('canvas');
          cvs.width = cvs.height = 1;
          _ctx = cvs.getContext('2d', { willReadFrequently: true });
        }
        // 两个哨兵先验有效性：赋一个非法值时 fillStyle 保持不变，
        // 用两个不同初值跑两遍，结果不一致就说明这个值浏览器不认。
        _ctx.fillStyle = '#010203'; _ctx.fillStyle = s; var a1 = _ctx.fillStyle;
        _ctx.fillStyle = '#040506'; _ctx.fillStyle = s; var a2 = _ctx.fillStyle;
        if (a1 === a2) {
          // 不能读 fillStyle 字符串 —— 现在的 Chrome 会把 lab()/oklch()/color()
          // 原样序列化回来，不再转成 sRGB。只有真画一个像素再读回来才拿得到数值。
          _ctx.clearRect(0, 0, 1, 1);
          _ctx.fillRect(0, 0, 1, 1);
          var px = _ctx.getImageData(0, 0, 1, 1).data;
          out = px[3] === 0 ? null : { r: px[0], g: px[1], b: px[2], a: px[3] / 255 };
        }
      } catch (e) { out = null; }
    }
    _memo[s] = out;
    return out;
  }

  function toHex(c) {
    return '#' + [c.r, c.g, c.b].map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('');
  }

  // ── 计数 ────────────────────────────────────────────────────
  function bump(map, k, n) { if (k == null || k === '') return; map[k] = (map[k] || 0) + (n || 1); }
  function top(o, n) {
    return Object.keys(o).map(function (k) { return [k, o[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n);
  }

  /**
   * CSS-in-JS 编译出来的原子变量是噪音（--sx-1a2b3c 这种）。
   * 判据：短横线后是一段无意义的字母数字混串，或者以下划线开头。
   * 保留 --color-x / --font-size-lg 这类人写的语义名。
   */
  function isNoiseVar(name) {
    var body = name.replace(/^--/, '');
    if (body.charAt(0) === '_') return true;
    if (/^[a-z]{1,3}-[a-z0-9]{5,}$/i.test(body) && !/-(color|size|width|height|space|radius)/i.test(body)) return true;
    if (/^[a-f0-9]{6,}$/i.test(body)) return true;
    return false;
  }

  // ── 主体 ────────────────────────────────────────────────────
  function teardown(opts) {
    opts = opts || {};
    var MAX = opts.maxElements || 20000;
    var TOP = opts.topN || 40;

    // 1. CSS 自定义属性 —— 有语义 token 的站，这里就是设计系统本身
    var allVars = {}, noiseCount = 0;
    var rootCS = getComputedStyle(document.documentElement);
    for (var i = 0; i < rootCS.length; i++) {
      var p = rootCS[i];
      if (p.indexOf('--') !== 0) continue;
      if (isNoiseVar(p)) { noiseCount++; continue; }
      allVars[p] = rootCS.getPropertyValue(p).trim();
    }
    // 主题容器上可能挂着另一套（深色/浅色），一并收
    try {
      var themeEls = document.querySelectorAll('[data-theme],[class*="theme"],body');
      for (var t = 0; t < Math.min(themeEls.length, 30); t++) {
        var tcs = getComputedStyle(themeEls[t]);
        for (var j = 0; j < tcs.length; j++) {
          var tp = tcs[j];
          if (tp.indexOf('--') !== 0 || isNoiseVar(tp) || allVars[tp] !== undefined) continue;
          allVars[tp] = tcs.getPropertyValue(tp).trim();
        }
      }
    } catch (e) { /* 主题容器读不到就算了 */ }

    // 1b. token 值里凡是颜色的，一律归一化成 hex 存一份。
    // 不这么做的话，用 lab()/oklch() 写 token 的站（Tailwind v4 等）没法把
    // 实测色追溯回 token，色板会全被标成「野色」—— 那是误报，不是发现。
    var varColors = {};
    for (var vk in allVars) {
      if (!Object.prototype.hasOwnProperty.call(allVars, vk)) continue;
      var vv = String(allVars[vk]).trim();
      // 只试看起来像单个颜色的值，避免把 `1px solid red` 这类简写误判
      if (!/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|lab|lch|oklab|oklch|color|hwb)\([^()]*(\([^()]*\))?[^()]*\))$/i.test(vv)) continue;
      var pc = parseColor(vv);
      if (pc) varColors[vk] = toHex(pc);
    }

    // 2. 交互态词汇 —— 从样式表规则里读，不需要真的去 hover
    var stateProps = { hover: {}, focus: {}, active: {}, dataState: {} };
    var sheetsBlocked = 0, sheetsRead = 0;
    var sheets = Array.prototype.slice.call(document.styleSheets);
    for (var si = 0; si < sheets.length; si++) {
      var rules;
      try { rules = sheets[si].cssRules; } catch (e) { sheetsBlocked++; continue; }
      if (!rules) continue;
      sheetsRead++;
      walkRules(rules);
    }
    function walkRules(rules) {
      for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        if (rule.cssRules) { walkRules(rule.cssRules); continue; }  // @media / @supports
        var sel = rule.selectorText;
        if (!sel || !rule.style) continue;
        var bucket = null;
        if (/:hover/.test(sel)) bucket = stateProps.hover;
        else if (/:focus/.test(sel)) bucket = stateProps.focus;
        else if (/:active/.test(sel)) bucket = stateProps.active;
        else if (/\[data-(state|open|selected|active)/.test(sel)) bucket = stateProps.dataState;
        if (!bucket) continue;
        for (var pi = 0; pi < rule.style.length; pi++) bump(bucket, rule.style[pi]);
      }
    }

    // 3. 遍历可见元素
    var colors = {}, colorRole = {}, fonts = {}, radii = {}, shadows = {},
      durations = {}, easings = {}, spacing = {}, gaps = {}, zIndex = {},
      transforms = {}, filters = {}, textStyles = {}, borderWidths = {};

    var els = document.querySelectorAll('body *');
    var seen = 0, skipped = 0;

    for (var e = 0; e < els.length && seen < MAX; e++) {
      var el = els[e];
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (err) { continue; }
      if (rect.width === 0 && rect.height === 0) { skipped++; continue; }
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') { skipped++; continue; }
      seen++;

      // 面积加权：大面积背景色比一个小图标的背景更能代表这个站
      var area = Math.max(1, Math.round(rect.width * rect.height / 1000));
      var weight = Math.min(area, 50);
      var hasText = false, textSample = '';
      for (var n = 0; n < el.childNodes.length; n++) {
        var node = el.childNodes[n];
        if (node.nodeType === 3 && node.textContent.trim().length > 1) {
          hasText = true;
          if (!textSample) textSample = node.textContent.trim().slice(0, 48);
        }
      }

      // 颜色 + 角色
      var fg = parseColor(cs.color), bg = parseColor(cs.backgroundColor), bc = parseColor(cs.borderTopColor);
      function role(h) { return colorRole[h] || (colorRole[h] = { text: 0, bg: 0, border: 0 }); }
      if (fg && hasText) { var fh = toHex(fg); bump(colors, fh); role(fh).text++; }
      if (bg) { var bh = toHex(bg); bump(colors, bh, weight); role(bh).bg += weight; }
      if (bc && parseFloat(cs.borderTopWidth) > 0) { var ch = toHex(bc); bump(colors, ch); role(ch).border++; }

      // 复合文字样式 —— 设计系统的真实单位，不是四个独立变量
      if (hasText) {
        var fam = cs.fontFamily;
        bump(fonts, fam);
        var famKey = /mono|courier|consol/i.test(fam) ? 'mono' : (/serif/i.test(fam) && !/sans-serif/i.test(fam) ? 'serif' : 'sans');
        var key = [famKey, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.textTransform].join('|');
        if (!textStyles[key]) textStyles[key] = { n: 0, tags: {}, sample: '' };
        textStyles[key].n++;
        bump(textStyles[key].tags, el.tagName);
        if (!textStyles[key].sample) textStyles[key].sample = textSample;
      }

      // 形状
      if (cs.borderRadius && cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
      if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
      var bw = cs.borderTopWidth;
      if (bw && parseFloat(bw) > 0) bump(borderWidths, bw);

      // 动效
      if (cs.transitionDuration && cs.transitionDuration !== '0s') {
        cs.transitionDuration.split(',').forEach(function (d) { bump(durations, d.trim()); });
        cs.transitionTimingFunction.split(/,(?![^(]*\))/).forEach(function (f) { bump(easings, f.trim()); });
      }
      if (cs.animationDuration && cs.animationDuration !== '0s') {
        cs.animationDuration.split(',').forEach(function (d) { bump(durations, d.trim()); });
      }
      if (cs.transform && cs.transform !== 'none') bump(transforms, cs.transform.slice(0, 60));
      if (cs.filter && cs.filter !== 'none') bump(filters, cs.filter.slice(0, 60));
      if (cs.backdropFilter && cs.backdropFilter !== 'none') bump(filters, 'backdrop:' + cs.backdropFilter.slice(0, 40));

      // 间距
      ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom'].forEach(function (prop) {
        var v = parseFloat(cs[prop]);
        if (v > 0 && v < 400) bump(spacing, Math.round(v));
      });
      if (cs.gap && cs.gap !== 'normal') {
        cs.gap.split(' ').forEach(function (g) { var v = parseFloat(g); if (v > 0) bump(gaps, Math.round(v)); });
      }
      if (cs.zIndex !== 'auto') bump(zIndex, cs.zIndex);
    }

    // 4. 整理输出
    var colorList = top(colors, TOP).map(function (pair) {
      var hex = pair[0];
      var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      var rl = colorRole[hex] || { text: 0, bg: 0, border: 0 };
      var dominant = rl.bg > rl.text * 3 ? 'bg' : (rl.border > rl.text ? 'border' : 'text');
      return { hex: hex, count: pair[1], oklch: rgbToOklch(r, g, b), role: dominant, roles: rl };
    });

    var styleList = Object.keys(textStyles).map(function (k) { return [k, textStyles[k]]; })
      .sort(function (a, b) { return b[1].n - a[1].n; }).slice(0, 24)
      .map(function (pair) {
        var parts = pair[0].split('|');
        var px = parseFloat(parts[1]);
        var tagList = Object.keys(pair[1].tags).map(function (t) { return [t, pair[1].tags[t]]; })
          .sort(function (a, b) { return b[1] - a[1]; });
        return {
          family: parts[0], size: parts[1], weight: parts[2],
          lineHeight: parts[3], tracking: parts[4], transform: parts[5],
          px: px,
          lhRatio: parts[3] === 'normal' ? null : +(parseFloat(parts[3]) / px).toFixed(3),
          trackEm: parts[4] === 'normal' ? 0 : +(parseFloat(parts[4]) / px).toFixed(4),
          count: pair[1].n,
          topTag: tagList.length ? tagList[0][0] : null,
          sample: pair[1].sample
        };
      });

    var semanticVars = Object.keys(allVars).length;

    return {
      meta: {
        url: location.href,
        origin: location.origin,
        title: document.title,
        capturedViewport: { w: window.innerWidth, h: window.innerHeight },
        scrollHeight: document.body.scrollHeight,
        dpr: window.devicePixelRatio,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        elementsScanned: seen,
        elementsSkipped: skipped,
        elementsTotal: els.length,
        truncated: els.length > MAX,
        semanticVarCount: semanticVars,
        noiseVarCount: noiseCount,
        stylesheetsRead: sheetsRead,
        stylesheetsBlocked: sheetsBlocked   // 跨域样式表读不到，交互态会不完整
      },
      vars: allVars,
      varColors: varColors,   // token 名 → 归一化 hex
      colors: colorList,
      textStyles: styleList,
      fonts: top(fonts, 10),
      radii: top(radii, 20),
      shadows: top(shadows, 14),
      borderWidths: top(borderWidths, 10),
      durations: top(durations, 20),
      easings: top(easings, 20),
      transforms: top(transforms, 14),
      filters: top(filters, 10),
      spacing: top(spacing, 30),
      gaps: top(gaps, 20),
      zIndex: top(zIndex, 20),
      states: {
        hover: top(stateProps.hover, 16),
        focus: top(stateProps.focus, 16),
        active: top(stateProps.active, 12),
        dataState: top(stateProps.dataState, 12)
      }
    };
  }

  if (typeof window !== 'undefined') window.__TEARDOWN__ = teardown;
  if (typeof module !== 'undefined' && module.exports) module.exports = teardown;
})();
