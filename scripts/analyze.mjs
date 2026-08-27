#!/usr/bin/env node
/**
 * web-teardown · 分析
 *
 * 把 teardown.mjs 采回来的原始数据变成结论。这一步才是这个 skill 的价值所在：
 * 原始频次表谁都能抓，能不能读出「这套系统在想什么」和「它哪里已经散了」才是区别。
 *
 * 用法：node analyze.mjs <teardown.json> [--out analysis.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const input = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!input) { console.error('用法: node analyze.mjs <teardown.json> [--out analysis.json]'); process.exit(1); }

const raw = JSON.parse(readFileSync(resolve(input), 'utf8'));
const pass = raw.passes[0];                     // 主轮：其余轮次用于对比，不参与主分析
const V = pass.vars || {};
const varNames = Object.keys(V);

// ── 工具 ──────────────────────────────────────────────────────
const HEX = /#[0-9a-f]{3,8}\b/gi;
// 展示上限：只决定报告里列几个，绝不参与个数和占比的计算。
const ROGUE_SHOWN = 8;
const OFFGRID_SHOWN = 8;
const DUR_SHOWN = 6;
const norm3 = (h) => h.length === 4 ? '#' + [1, 2, 3].map((i) => h[i] + h[i]).join('') : h.slice(0, 7);
const num = (s) => { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : NaN; };

/** 中性色判据：彩度低到肉眼分不出色相。0.04 是经验阈值，再高就是有意的淡彩了。 */
const isNeutral = (c) => c.oklch.C < 0.04;

/**
 * 纯灰判据。必须排掉纯白纯黑 —— 它们无彩度是数学必然，不是设计选择，
 * 混进来会让"中性色里混了纯灰"这条发现每个站都误报。
 */
const isPureGrey = (c) => c.oklch.C < 0.0008 && c.oklch.L > 1.5 && c.oklch.L < 98.5;

/** cubic-bezier 归一化成四个数，绕开 `.25` 与 `0.25` 这类写法差异 */
function bezierKey(s) {
  const m = String(s).match(/cubic-bezier\(([^)]+)\)/i);
  if (!m) return String(s).trim().toLowerCase();
  const n = m[1].split(',').map((x) => parseFloat(x));
  return n.length === 4 && n.every((x) => !isNaN(x)) ? 'cb:' + n.map((x) => +x.toFixed(4)).join(',') : s;
}

/** hex → OKLCH。token 声明的色值不一定出现在实测色板里，这时要自己算 */
function hexToOklch(hex) {
  const h = norm3(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lr = f(r / 255), lg = f(g / 255), lb = f(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s2 = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s2;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s2;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s2;
  const C = Math.sqrt(A * A + B * B);
  let H = Math.atan2(B, A) * 180 / Math.PI; if (H < 0) H += 360;
  return { L: +(L * 100).toFixed(1), C: +C.toFixed(4), H: C < 0.0008 ? null : +H.toFixed(1) };
}

/** 角度距离（0–180） */
const hueDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** 时长归一化成秒。`.15s` / `0.15s` / `150ms` 是同一个值，不能当三个 */
function durKey(s) {
  const t = String(s).trim();
  const n = parseFloat(t);
  if (isNaN(n)) return t;
  return +(/ms$/i.test(t) ? n / 1000 : n).toFixed(4);
}

// ── 1. 置信度分级 ─────────────────────────────────────────────
// 站点暴不暴露语义 token，决定了这份报告能说到什么程度。必须先说清楚。
function grade() {
  const n = pass.meta.semanticVarCount;
  if (n >= 60) return {
    level: 'A', label: '系统可读',
    note: `站点在 :root 暴露了 ${n} 个语义 token，读到的是设计系统本身，不是猜的。`,
  };
  if (n >= 15) return {
    level: 'B', label: '部分可读',
    note: `只找到 ${n} 个语义 token，系统露出一角。配色和字体阶梯以实测为准，`
      + `token 只作旁证 —— 报告里凡是"他们打算怎么用"的判断都要降调。`,
  };
  return {
    level: 'C', label: '仅实测',
    note: `只有 ${n} 个语义 token（另有 ${pass.meta.noiseVarCount} 个 CSS-in-JS 编译原子已滤除）。`
      + `这份报告只能回答"页面上用了什么"，回答不了"系统打算怎么用"。`
      + `不要写"他们定义了…"这类句子，全部改成"实测出现…"。`,
  };
}

// ── 2. Token 分类 ─────────────────────────────────────────────
const CATS = [
  ['color', /^--(color|colour)-|-(color|colour)$|^--(bg|fg|text|border|line|accent|brand)-/i],
  ['type', /^--(font|text|title|heading|type|leading|tracking|line-height|letter-spacing)-/i],
  ['motion', /^--(ease|speed|duration|transition|anim)/i],
  ['shadow', /shadow/i],
  ['radius', /radius|rounded/i],
  ['layer', /^--(layer|z-|zindex)/i],
  ['space', /^--(space|spacing|gap|inset|padding|margin)/i],
  ['size', /(width|height|size)$|^--(size|breakpoint|screen)/i],
];
function classifyTokens() {
  const out = Object.fromEntries(CATS.map(([k]) => [k, {}]));
  out.other = {};
  for (const name of varNames) {
    const hit = CATS.find(([, re]) => re.test(name));
    (hit ? out[hit[0]] : out.other)[name] = V[name];
  }
  return out;
}

// ── 3. 中性色分析 ─────────────────────────────────────────────
// 一套系统对中性色的处理最能说明它的成熟度：随手用 #888 还是调过色相。
function neutrals() {
  const list = pass.colors.filter(isNeutral);
  const tinted = list.filter((c) => c.oklch.C >= 0.0008 && c.oklch.H !== null);
  const pure = list.filter(isPureGrey);

  // 按色相聚类（30° 一档），找出主色相族
  const buckets = {};
  for (const c of tinted) {
    const b = Math.round(c.oklch.H / 30) * 30 % 360;
    (buckets[b] ||= []).push(c);
  }
  const clusters = Object.entries(buckets)
    .map(([h, cs]) => ({
      hue: +h, count: cs.length,
      avgC: +(cs.reduce((s, c) => s + c.oklch.C, 0) / cs.length).toFixed(4),
      members: cs.map((c) => c.hex),
    }))
    .sort((a, b) => b.count - a.count);

  // 品牌色：有 token 命名就直接信它。纯靠彩度排序会把一个只用了十几次的
  // 荧光色当成品牌色 —— 那多半是个高亮或报错态。
  const chromatic = pass.colors.filter((c) => !isNeutral(c));
  let brand = null;
  // 注意用非全局正则：HEX 带 /g，.test() 会推进 lastIndex，在 find 里逐次调用会交替返回假值
  const brandToken = Object.entries(V).find(([k, v]) =>
    /^--(color-)?(brand|accent|primary)(-(bg|color|default|base))?$/i.test(k)
    && /#[0-9a-f]{3,8}\b/i.test(String(v)));
  if (brandToken) {
    const m = String(brandToken[1]).match(/#[0-9a-f]{3,8}\b/i);
    if (m) {
      const hex = norm3(m[0]).toLowerCase();
      const measured = pass.colors.find((c) => c.hex.toLowerCase() === hex);
      // 页面上没大面积用不代表它不是品牌色 —— 声明了就认，自己补算 OKLCH
      brand = measured || { hex, count: 0, oklch: hexToOklch(hex), role: 'declared' };
      brand = { ...brand, token: brandToken[0] };
    }
  }
  if (!brand) {
    // 退回：彩度过线的颜色里挑用量最大的，而不是彩度最高的
    brand = chromatic.filter((c) => c.oklch.C >= 0.08).sort((a, b) => b.count - a.count)[0]
      || chromatic.sort((a, b) => b.oklch.C - a.oklch.C)[0] || null;
  }
  // 派生 = 中性色的主色相族确实聚在品牌色附近（90° 以内），而不是各散各的
  const weighted = clusters.slice(0, 3);
  const near = brand ? weighted.filter((cl) => hueDist(cl.hue, brand.oklch.H) <= 90) : [];
  const derived = brand
    && near.reduce((s, c) => s + c.count, 0) >= weighted.reduce((s, c) => s + c.count, 0) * 0.6;

  return {
    total: list.length,
    tintedCount: tinted.length,
    pureGreys: pure.map((c) => c.hex),
    clusters: clusters.slice(0, 5),
    brand: brand ? { hex: brand.hex, oklch: brand.oklch, token: brand.token || null, count: brand.count } : null,
    // 中性色全部带彩度 + 色相聚在品牌色附近 = 有意调过，不是默认灰
    intentional: tinted.length > 0 && pure.length <= 1 && derived,
  };
}

// ── 4. 字体阶梯 ───────────────────────────────────────────────
function typography() {
  const styles = pass.textStyles.filter((s) => s.px > 0);
  const weights = [...new Set(styles.map((s) => +s.weight))].sort((a, b) => a - b);
  const offHundred = weights.filter((w) => w % 100 !== 0);

  // 字距曲线：有 token 就读 token（干净），没有才退回实测（有噪音）
  const declared = declaredTypeScale();
  let curve, curveSource;
  if (declared.length >= 5) {
    curve = declared;
    curveSource = 'token';
  } else {
    const bySize = {};
    for (const s of styles) {
      const cur = bySize[s.px];
      if (!cur || s.count > cur.count) bySize[s.px] = s;
    }
    curve = Object.values(bySize).sort((a, b) => a.px - b.px)
      .map((s) => ({ px: s.px, trackEm: s.trackEm, lhRatio: s.lhRatio, weight: +s.weight, count: s.count }));
    curveSource = 'measured';
  }

  // 找字距的台阶。必须按族分开算 —— 一个系统可以有好几套平行阶梯
  // (--text-* 正文档 / --title-* 标题档)，混在一起排序会伪造出假台阶。
  // 一族里超过 2 个台阶就说明这族根本没有台阶，别硬讲故事。
  const families = curveSource === 'token' ? byFamily(curve)
    : [['measured', curve]];
  const steps = [];
  const familyCurves = [];
  for (const [fam, rows] of families) {
    const sorted = rows.slice().sort((a, b) => a.px - b.px);
    familyCurves.push({ family: fam, rows: sorted });
    const local = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = Math.abs((sorted[i].trackEm || 0) - (sorted[i - 1].trackEm || 0));
      if (d >= 0.005) local.push({ family: fam, from: sorted[i - 1].px, to: sorted[i].px, delta: +d.toFixed(4) });
    }
    if (local.length && local.length <= 2) steps.push(...local);
  }

  // 行高是否随字号收紧 —— 成熟排版系统的标志
  const withLh = curve.filter((c) => c.lhRatio);
  let lhTrend = null;
  if (withLh.length >= 4) {
    const small = withLh.filter((c) => c.px <= 18), big = withLh.filter((c) => c.px >= 28);
    if (small.length && big.length) {
      const avg = (a) => a.reduce((s, c) => s + c.lhRatio, 0) / a.length;
      lhTrend = { small: +avg(small).toFixed(2), large: +avg(big).toFixed(2) };
    }
  }

  const fams = pass.fonts.map(([f]) => f);
  return {
    weights, offHundred,
    curve, curveSource, steps, familyCurves,
    lhTrend,
    families: fams.slice(0, 4),
    hasVariable: /variable|var\b/i.test(fams.join(' ')) || offHundred.length > 0,
    featureSettings: V['--font-settings'] || V['--font-feature-settings'] || null,
    variationSettings: V['--font-variations'] || V['--font-variation-settings'] || null,
  };
}

// ── 5. 漂移检测 ───────────────────────────────────────────────
// 这是全套里最有价值的一段：token 里写的和页面上跑的对不上的地方。
// 人眼读 CSS 读不出来，只有全量测量会撞见。
function drift() {
  const out = [];

  // 5a. 时长：实测出现但 token 里没有
  const declaredDurRaw = Object.entries(V).filter(([k]) => /speed|duration/i.test(k))
    .map(([, v]) => v.trim()).filter(Boolean);
  const declaredDur = new Set(declaredDurRaw.map(durKey));
  if (declaredDur.size) {
    const rogueAllDur = pass.durations
      .filter(([d]) => !declaredDur.has(durKey(d)) && num(d) > 0 && num(d) < 1);  // 长动画多是环境动效，不算漂移
    const rogue = rogueAllDur.slice(0, DUR_SHOWN);
    if (rogue.length) out.push({
      kind: 'drift', id: 'duration-rogue',
      title: '有动画时长不在 token 表里',
      data: { declared: declaredDurRaw, rogue, total: rogueAllDur.length, shown: rogue.length },
      body: `速度 token 定义了 ${declaredDur.size} 档（${declaredDurRaw.join(' / ')}），`
        + `但实测出现了 ${rogueAllDur.length} 个表外的值`
        + (rogueAllDur.length > rogue.length ? `，按频次列前 ${rogue.length} 个` : '')
        + `：${rogue.map(([d, n]) => `${d}（${n} 次）`).join('、')}。`
        + `其中 ${rogue[0][0]} 出现最多 —— 系统和实现已经分家。`,
    });
  }

  // 5b. 缓动：定义了但没人用
  const declaredEase = Object.entries(V).filter(([k]) => /^--ease/i.test(k));
  if (declaredEase.length >= 3) {
    const usedRaw = new Set(pass.easings.map(([e]) => bezierKey(e)));
    const used = declaredEase.filter(([, v]) => usedRaw.has(bezierKey(v)));
    const dead = declaredEase.length - used.length;
    if (dead >= 3) out.push({
      kind: 'drift', id: 'ease-deadstock',
      title: `${declaredEase.length} 条缓动定义，实测只用上 ${used.length} 条`,
      data: { declared: declaredEase.length, used: used.map(([k]) => k), dead },
      body: `token 里备齐了整套缓动，扫描 ${pass.meta.elementsScanned} 个元素只检测到 `
        + `${used.length ? used.map(([k]) => k).join('、') : '一条都没有'} 在用，`
        + `其余 ${dead} 条是死库存。这是设计系统最常见的一种腐烂方式。`,
    });
  }

  // 5c. 野色：实测颜色追不到任何 token
  // 优先用 probe 归一化好的 varColors —— 覆盖 lab()/oklch() 这类非 hex 写法。
  // 再补上从 token 值里直接抠出的 hex（阴影、渐变那种混在长串里的）。
  const tokenHex = new Set(Object.values(pass.varColors || {}).map((h) => String(h).toLowerCase()));
  for (const v of Object.values(V)) {
    for (const m of String(v).matchAll(HEX)) tokenHex.add(norm3(m[0]).toLowerCase());
  }
  if (tokenHex.size >= 10) {
    // 个数和占比一律用完整列表算 —— slice 只是展示上限，不能反过来决定数字。
    const rogueAll = pass.colors.filter((c) => !tokenHex.has(c.hex.toLowerCase()) && c.count >= 5);
    const rogue = rogueAll.slice(0, ROGUE_SHOWN);
    const pct = Math.round(rogueAll.length / pass.colors.length * 100);
    if (rogueAll.length >= 3) out.push({
      kind: 'drift', id: 'color-rogue',
      title: `${rogueAll.length} 个高频颜色追不到 token`,
      data: {
        rogue: rogue.map((c) => ({ hex: c.hex, count: c.count, role: c.role })),
        total: rogueAll.length, shown: rogue.length, pct,
      },
      body: `实测的 ${pass.colors.length} 个高频色里，有 ${rogueAll.length} 个（约 ${pct}%）不在任何 CSS 变量里`
        + (rogueAll.length > rogue.length
          ? `，按频次列前 ${rogue.length} 个：`
          : `：`)
        + `${rogue.slice(0, 5).map((c) => c.hex).join('、')}。`
        + `可能是硬编码，也可能来自第三方组件或 CSS-in-JS —— 无论哪种，色板已经漏了。`,
    });
  }

  // 5d. 中性色里的异类
  const nt = neutrals();
  if (nt.tintedCount >= 4 && nt.pureGreys.length >= 1 && nt.pureGreys.length <= 2) {
    // 找到这个纯灰对应的 token 名，和它彩度正常的邻居
    const names = nt.pureGreys.map((hex) => {
      const owner = varNames.find((k) => String(V[k]).toLowerCase().includes(hex.toLowerCase()));
      return { hex, token: owner || null };
    });
    out.push({
      kind: 'drift', id: 'neutral-outlier',
      title: '中性色里混进了纯灰',
      data: { pure: names, clusterHue: nt.clusters[0]?.hue },
      body: `其余 ${nt.tintedCount} 个中性色全部带彩度、色相聚在 ${nt.clusters[0]?.hue}° 附近，`
        + `唯独 ${names.map((n) => n.token ? `${n.token}（${n.hex}）` : n.hex).join('、')} 彩度是 0.0000。`
        + `整套系统里唯一的纯灰 —— 大概率是漏网的那一个。`,
    });
  }

  // 5e. 间距离网格
  const spaceVals = pass.spacing.map(([v, n]) => [+v, n]).filter(([v]) => v <= 128);
  const { base } = detectBase(pass.spacing);
  if (base >= 4) {
    // 同上：个数和占比用完整列表，slice 只管展示。
    const offAll = spaceVals.filter(([v, n]) => v % base !== 0 && n >= 5);
    const off = offAll.slice(0, OFFGRID_SHOWN);
    const total = spaceVals.reduce((s, [, n]) => s + n, 0);
    const offCount = offAll.reduce((s, [, n]) => s + n, 0);
    if (offAll.length >= 3) out.push({
      kind: 'drift', id: 'space-offgrid',
      title: `间距基数是 ${base}，但有 ${offAll.length} 个高频值不在网格上`,
      data: { base, off, total: offAll.length, shown: off.length, offRatio: +(offCount / total).toFixed(3) },
      body: `${off.map(([v, n]) => `${v}px（${n} 次）`).join('、')}`
        + (offAll.length > off.length ? ` 等 ${offAll.length} 个值` : '')
        + ` 都不是 ${base} 的倍数，`
        + `合计占实测间距的 ${Math.round(offCount / total * 100)}%。少量是光学微调，成片出现就是网格没守住。`,
    });
  }

  return out;
}

/**
 * 猜间距基数网格。两处讲究：
 *  1. 按出现次数加权 —— 用了 132 次的 8px 和只用过 1 次的 19px 不该同权；
 *  2. 只认 ≥4 的基数 —— 2px「网格」在数学上永远成立，说了等于没说。
 * 返回 0 表示这个站没有可辨认的网格，这本身也是一条结论。
 */
function detectBase(pairs) {
  const vals = pairs.map(([v, n]) => [+v, +n]).filter(([v]) => v > 0 && v <= 200);
  const total = vals.reduce((s, [, n]) => s + n, 0);
  if (!total) return { base: 0, coverage: 0 };
  // 升序取第一个达标的：基数是系统允许的**最细**粒度。
  // 取最大的那个会把 4px、12px 判成「离网格」—— 它们明明在 4 的网格上。
  for (const b of [4, 6, 8]) {
    const hit = vals.filter(([v]) => v % b === 0).reduce((s, [, n]) => s + n, 0) / total;
    if (hit >= 0.65) return { base: b, coverage: +hit.toFixed(3) };
  }
  return { base: 0, coverage: 0 };
}

/** 求值简单的 calc()：只支持 `a / b` 和 `a * b`，其余返回 NaN。
 *  Tailwind 的行高全是 calc(1.25 / .875) 这种比值写法，不算就读不出来。 */
function evalCalc(v) {
  const m = String(v).match(/^calc\(\s*([\d.]+)[a-z%]*\s*([*/])\s*([\d.]+)[a-z%]*\s*\)$/i);
  if (!m) return NaN;
  const a = parseFloat(m[1]), b = parseFloat(m[3]);
  if (isNaN(a) || isNaN(b) || (m[2] === '/' && b === 0)) return NaN;
  return m[2] === '/' ? a / b : a * b;
}

/**
 * 字距/字号阶梯优先从 token 读，读不到才退回实测。
 * 实测拿到的是浏览器算完的结果，噪音大到看不出台阶；token 里写的才是系统的意图。
 *
 * 四种写法都要认 —— 各家约定完全不一样：
 *   1. 后缀式    --title-3-size / --title-3-line-height / --title-3-letter-spacing
 *   2. 双短横线   --text-sm: .875rem  +  --text-sm--line-height   （Tailwind v4）
 *   3. font 简写  --title-7: 590 3.5rem / 1.1 "Inter…"            （Linear）
 *   4. 裸长度值   --font-size-lg: 1.125rem
 * 只认其中一种的话，另外几家的站会白白退回实测曲线。
 */
function declaredTypeScale() {
  const rootPx = 16;
  const entries = {};
  const put = (key, field, val) => {
    const e = entries[key] || (entries[key] = {});
    if (e[field] === undefined) e[field] = val;      // 先到先得
  };

  // 简写和裸值的优先级低于显式后缀，所以分两轮：先收显式的，再补简写的
  const shorthand = [];

  // 后缀可能是 kebab（--title-3-line-height）、驼峰（--hds-font-heading-md-lineHeight）
  // 或双短横线（--text-sm--line-height）。归一化后统一比对，别为每家写一条正则。
  const SUFFIX = /^(--.+?)-{1,2}(font-?size|size|line-?height|letter-?spacing|tracking|font-?weight|weight)$/i;
  const FIELD = {
    fontsize: 'size', size: 'size',
    lineheight: 'line-height',
    letterspacing: 'letter-spacing', tracking: 'letter-spacing',
    fontweight: 'font-weight', weight: 'font-weight',
  };

  for (const [k, vRaw] of Object.entries(V)) {
    const v = String(vRaw).trim();
    let m;
    // 1+2. 后缀式（三种写法归一处理）
    if ((m = k.match(SUFFIX))) {
      const field = FIELD[m[2].toLowerCase().replace(/-/g, '')];
      // `size` 太通用了 —— 必须是排版类 key 才收，否则 --scrollbar-size、
      // --min-tap-size 这种尺寸 token 会被当成字号。
      if (field && (field !== 'size' || /(font|text|title|heading|type|display)/i.test(k))) {
        put(m[1], field, v); continue;
      }
    }
    // 3. font 简写：可选字重 + 字号 / 行高 + 字体族
    if ((m = v.match(/^(\d{2,3})?\s*([\d.]+(?:rem|px|em))\s*\/\s*([\d.]+[a-z%]*|calc\([^)]+\))\s+\S/i))) {
      shorthand.push([k, { size: m[2], 'line-height': m[3], 'font-weight': m[1] }]); continue;
    }
    // 4. 裸长度值。必须整体就是一个长度 —— 否则 --text-shadow-sm: 0px 1px 0px #000
    //    这种会被当成字号收进来。
    if (/^--(text|font-size|title|heading|type|display|fs)\b/i.test(k)
      && /^[\d.]+(rem|px|em)$/i.test(v)) {
      shorthand.push([k, { size: v }]); continue;
    }
  }
  for (const [k, fields] of shorthand) {
    for (const [f, val] of Object.entries(fields)) if (val != null) put(k, f, val);
  }

  const toPx = (raw) => {
    if (raw == null) return NaN;
    const s = String(raw).trim();
    const c = evalCalc(s);
    if (!isNaN(c)) return /rem/i.test(s) ? c * rootPx : c;
    const n = num(s);
    if (isNaN(n)) return NaN;
    if (/rem$/i.test(s)) return n * rootPx;
    if (/em$/i.test(s)) return NaN;                  // 相对父级，定不了绝对值
    return n;                                        // px 或裸数
  };

  const rows = [];
  for (const [key, e] of Object.entries(entries)) {
    const px = toPx(e.size);
    if (isNaN(px) || px <= 0 || px > 400) continue;

    // 字距：em 直接用，px 换算成 em
    let trackEm = 0;
    if (e['letter-spacing'] != null) {
      const t = String(e['letter-spacing']);
      const tn = num(t);
      if (!isNaN(tn)) trackEm = /em$/i.test(t) ? tn : (/px$/i.test(t) ? tn / px : tn);
    }

    // 行高：比值直接用，px 换算成比值，calc(a/b) 求值
    let lhRatio = null;
    if (e['line-height'] != null) {
      const l = String(e['line-height']);
      const c = evalCalc(l);
      if (!isNaN(c)) lhRatio = +c.toFixed(3);
      else {
        const ln = num(l);
        if (!isNaN(ln)) lhRatio = /px$/i.test(l) ? +(ln / px).toFixed(3) : (/%$/.test(l) ? +(ln / 100).toFixed(3) : ln);
      }
    }

    const w = e['font-weight'] != null ? parseInt(e['font-weight'], 10) : null;
    // 族名 = 去掉最后一段（那是阶梯档位）。取第一段的话
    // --hds-font-heading-md / --hds-font-body-md 会全挤进一个 "hds" 族。
    const bare = key.replace(/^--/, '');
    const family = (bare.replace(/-[^-]+$/, '') || bare).toLowerCase();
    rows.push({
      token: key, family, px: +px.toFixed(1),
      trackEm: +(trackEm || 0).toFixed(4), lhRatio,
      weight: isNaN(w) ? null : w,
    });
  }
  const rich = rows.some((r) => r.lhRatio != null || r.trackEm);
  const kept = rich
    ? rows.filter((r) => {
      const fam = rows.filter((x) => x.family === r.family);
      return fam.some((x) => x.lhRatio != null || x.trackEm);
    })
    : rows;
  return kept.sort((a, b) => a.px - b.px);
}

/** 把阶梯按族拆开，只留成员数够的族 */
function byFamily(rows) {
  const g = {};
  for (const r of rows) (g[r.family] ||= []).push(r);
  return Object.entries(g).filter(([, rs]) => rs.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
}

// ── 6. 签名发现 ───────────────────────────────────────────────
// 不是"它有什么"，是"它跟别人不一样在哪"。
function signatures() {
  const out = [];
  const ty = typography();
  const nt = neutrals();

  if (ty.offHundred.length) out.push({
    kind: 'signature', id: 'weights-off-hundred',
    title: '字重不是整百',
    data: { weights: ty.weights, off: ty.offHundred },
    body: `实测字重 ${ty.weights.join(' / ')}，其中 ${ty.offHundred.join('、')} 不是整百。`
      + `这是可变字体的痕迹 —— 按视觉重量取值，而不是沿用静态字体那套档位。`,
  });

  // 找「恰好只有一个台阶」的那一族 —— 那才是干净的两档制。
  // 不能看 steps 总数：一个系统有好几套平行阶梯，各族的台阶会累加。
  const stepPerFam = {};
  for (const st of ty.steps) (stepPerFam[st.family] ||= []).push(st);
  const cleanFam = Object.entries(stepPerFam).filter(([, sts]) => sts.length === 1)
    .sort((a, b) => (ty.familyCurves.find((f) => f.family === b[0])?.rows.length || 0)
      - (ty.familyCurves.find((f) => f.family === a[0])?.rows.length || 0))[0];
  if (cleanFam) {
    const s = cleanFam[1][0];
    out.push({
      kind: 'signature', id: 'tracking-step',
      title: `${s.to}px 是字距的分水岭`,
      data: s,
      body: `--${s.family}-* 这套阶梯的字距在 ${s.from}px 到 ${s.to}px 之间突变 ${s.delta}em，`
        + `前后各自平稳。不是连续曲线，是硬切换的两档。`,
    });
  }

  // 判据允许 1 个纯灰例外，所以标题不能写死「没有一个」——
  // 否则会和 neutral-outlier 那条漂移自相矛盾。
  if (nt.intentional) {
    const hasException = nt.pureGreys.length > 0;
    out.push({
      kind: 'signature', id: 'neutrals-tinted',
      title: hasException ? '中性色几乎全部调过色相' : '没有一个纯灰',
      data: { clusters: nt.clusters, brand: nt.brand, exception: nt.pureGreys },
      body: `${nt.tintedCount} 个中性色带彩度，色相聚在 `
        + `${nt.clusters.slice(0, 3).map((c) => c.hue + '°').join(' / ')}`
        + (nt.brand ? `，而品牌色在 ${nt.brand.oklch.H}° —— 中性色是从品牌色派生的，不是默认灰。` : '。')
        + (hasException ? `（唯一的例外 ${nt.pureGreys.join('、')} 见上面的漂移一条。）` : ''),
    });
  }

  if (ty.lhTrend && ty.lhTrend.large < ty.lhTrend.small - 0.15) out.push({
    kind: 'craft', id: 'lh-inverse',
    title: '行高与字号成反比',
    data: ty.lhTrend,
    body: `小字平均行高 ${ty.lhTrend.small}，大字收到 ${ty.lhTrend.large}。`
      + `字越大行距越紧 —— 教科书做法，但真做到的站不多。`,
  });

  if (ty.featureSettings || ty.variationSettings) out.push({
    kind: 'craft', id: 'font-features',
    title: '字体调到了字符变体这一层',
    data: { features: ty.featureSettings, variations: ty.variationSettings },
    body: [
      ty.featureSettings ? `\`font-feature-settings: ${ty.featureSettings}\`` : null,
      ty.variationSettings ? `\`font-variation-settings: ${ty.variationSettings}\`` : null,
    ].filter(Boolean).join(' 加 ') + '。这是有人专门坐下来调过字的信号。',
  });

  // z-index 全语义命名 + 相邻层只差 1
  const layers = Object.entries(V).filter(([k]) => /^--(layer|z-)/i.test(k))
    .map(([k, v]) => [k, parseInt(v, 10)]).filter(([, v]) => !isNaN(v)).sort((a, b) => a[1] - b[1]);
  if (layers.length >= 6) {
    const adjacent = layers.filter(([, v], i) => i > 0 && v - layers[i - 1][1] === 1 && v >= 10);
    out.push({
      kind: 'craft', id: 'layer-semantics',
      title: `${layers.length} 层 z-index 全部语义命名`,
      data: { layers, adjacent },
      body: `从 ${layers[0][0]} ${layers[0][1]} 排到 ${layers.at(-1)[0]} ${layers.at(-1)[1]}，没有一处裸写数字。`
        + (adjacent.length ? `而且 ${adjacent[0][0]} 只比上一层大 1 —— 把"紧贴在下面"编进了数值。` : ''),
    });
  }

  // 交互态词汇：这个站 hover 的时候到底改什么
  const hov = pass.states?.hover || [];
  if (hov.length >= 3) {
    const props = hov.slice(0, 5).map(([p]) => p);
    out.push({
      kind: 'craft', id: 'hover-vocabulary',
      title: 'hover 只动这几样',
      data: { props: hov.slice(0, 8) },
      body: `所有 :hover 规则里改得最多的是 ${props.join('、')}。`
        + (props.some((p) => /transform|scale/.test(p)) ? '' : ' 全程不碰 transform —— 克制型交互。'),
    });
  }

  return out;
}

// ── 输出 ──────────────────────────────────────────────────────
const nt = neutrals();
const analysis = {
  tool: 'web-teardown', version: 1,
  target: raw.target,
  capturedAt: raw.capturedAt,
  channel: raw.channel,
  meta: pass.meta,
  varColors: pass.varColors || {},
  confidence: grade(),
  tokens: classifyTokens(),
  tokenCount: varNames.length,
  neutrals: nt,
  typography: typography(),
  colors: pass.colors,
  spacing: { ...detectBase(pass.spacing), measured: pass.spacing },
  radii: pass.radii,
  shadows: pass.shadows,
  motion: { durations: pass.durations, easings: pass.easings },
  layers: pass.zIndex,
  states: pass.states,
  fonts: pass.fonts,
  findings: [...drift(), ...signatures()],
  otherPasses: raw.passes.slice(1).map((p) => ({
    viewport: p.meta.requestedViewport, theme: p.meta.requestedTheme,
    elements: p.meta.elementsScanned, topColors: p.colors.slice(0, 8).map((c) => c.hex),
  })),
};

const outPath = resolve(flag('out', input.replace(/\.json$/, '') + '-analysis.json'));
writeFileSync(outPath, JSON.stringify(analysis, null, 2));

process.stderr.write(
  `置信度 ${analysis.confidence.level}（${analysis.confidence.label}） · `
  + `${analysis.tokenCount} token · ${analysis.findings.length} 条发现 `
  + `(漂移 ${analysis.findings.filter((f) => f.kind === 'drift').length})\n`
);
console.log(outPath);
