#!/usr/bin/env node
/**
 * web-teardown · 渲染
 *
 * analysis.json → 一张自包含的解剖图 HTML。
 *
 * 这是基线，不是天花板。数据够好、要当门面作品发出去的时候，
 * 让 agent 照 references/report.md 手写版面 —— 模板保证「每次都不难看」，
 * 手写才可能「这次特别好」。
 *
 * 用法：node report.mjs <analysis.json> [--out report.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const input = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!input) { console.error('用法: node report.mjs <analysis.json> [--out report.html]'); process.exit(1); }

const A = JSON.parse(readFileSync(resolve(input), 'utf8'));
const host = new URL(A.target).hostname.replace(/^www\./, '');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (n) => Math.round(n * 100);

/** hex → 声明它的 token 名。追不到就返回 null —— 追不到本身也是信息。 */
const tokenIndex = (() => {
  const map = new Map();
  // probe 归一化过的优先 —— 非 hex 写法的 token 只有这里能追到
  for (const [k, hex] of Object.entries(A.varColors || {})) {
    const h = String(hex).toLowerCase();
    if (!map.has(h)) map.set(h, k);
  }
  for (const cat of Object.values(A.tokens || {})) {
    for (const [k, v] of Object.entries(cat)) {
      for (const m of String(v).matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        const h = (m[0].length === 4 ? '#' + [1, 2, 3].map((i) => m[0][i] + m[0][i]).join('') : m[0].slice(0, 7)).toLowerCase();
        if (!map.has(h)) map.set(h, k);
      }
    }
  }
  return map;
})();
const tokenFor = (hex) => tokenIndex.get(String(hex).toLowerCase()) || null;

/* 批注色取目标站品牌色的色相，但明度和彩度锁死 —— 每份报告带着被解剖对象的色调，
   又不会因为对方用了个荧光色就变得读不了。 */
const hue = A.neutrals?.brand?.oklch?.H ?? 25;
const MARK_LIGHT = `oklch(50% 0.17 ${hue})`;
const MARK_DARK = `oklch(74% 0.15 ${hue})`;

// ── 片段构造 ──────────────────────────────────────────────────

function findings() {
  const order = { drift: 0, signature: 1, craft: 2 };
  const list = [...(A.findings || [])].sort((a, b) => order[a.kind] - order[b.kind]);

  // 一条都没有不等于没话说 —— 「查了这么多项，一项都没触发」本身就是结论。
  // 空着一节比写清楚更糟：读者会以为是工具没跑完。
  if (!list.length) {
    const lv = A.confidence?.level;
    return section('01', '指纹', '未触发', `
      <p class="lede">全部检测项跑完，<b>一条都没有触发</b>。</p>
      <div class="finds"><div class="find">
        <span class="idx">—</span>
        <div><h3>${lv === 'C' ? '这个站没有可读的设计系统' : '没有检出可称之为「系统」的规律'}</h3>
        <p>${lv === 'C'
        ? `没有语义 token，间距没有可辨认的基数网格，字号阶梯读的是实测值。
             这不是工具没跑完 —— 是这个站的样式确实是一处一处写出来的，不是从一套系统里取的。
             对老站和纯 HTML 页面来说这很正常，报告到这里就该停，下面几节只有描述性数据。`
        : `token 和实测值之间没有对不上的地方，也没有检出足够反常的手法。
             要么这个站的系统执行得很干净，要么它简单到不需要系统。往下看具体数值自己判断。`}</p></div>
      </div></div>`);
  }
  const KIND = { drift: '漂移', signature: '签名', craft: '手艺' };
  return section('01', '指纹', `${list.length} 条`, `
    <p class="lede">一套设计系统的性格不在它的配色，在它的<b>例外</b>和<b>取舍</b>。
    标着「漂移」的是 token 里写的和页面上跑的对不上的地方 —— 人眼读 CSS 读不出来，只有全量测量会撞见。</p>
    <div class="finds">${list.map((f, i) => `
      <div class="find">
        <span class="idx">${String(i + 1).padStart(2, '0')}<b class="kind ${f.kind}">${KIND[f.kind] || ''}</b></span>
        <div><h3>${esc(f.title)}</h3><p>${inlineCode(f.body)}</p></div>
      </div>`).join('')}</div>`);
}

/** 正文里的 `code` 和 #hex 上色，让数值从句子里跳出来 */
function inlineCode(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(#[0-9a-fA-F]{6}\b)(?![^<]*<\/code>)/g, '<code>$1</code>');
}

function trackingChart() {
  const fams = (A.typography?.familyCurves || []).filter((f) => f.rows.length >= 3);
  if (!fams.length) return '';
  const all = fams.flatMap((f) => f.rows);

  /* 画哪条曲线由数据决定。字距是首选，但有的系统（Tailwind v4）把字距做成
     独立命名的 --tracking-*，不绑字号 —— 那时字距图会是压在 0 上的一条平线，
     没有任何信息。这种情况改画行高比：它同样能看出「字越大排得越紧」。 */
  const hasTrack = all.some((r) => r.trackEm);
  const hasLh = all.some((r) => r.lhRatio != null);
  if (!hasTrack && !hasLh) return '';
  const mode = hasTrack ? 'track' : 'lead';

  const rows = (f) => f.rows.filter((r) => mode === 'track' ? true : r.lhRatio != null);
  const usable = fams.filter((f) => rows(f).length >= 3);
  if (!usable.length) return '';
  const pts = usable.flatMap(rows);

  const val = (r) => mode === 'track' ? Math.abs(r.trackEm || 0) : r.lhRatio;
  const maxPx = Math.max(...pts.map((r) => r.px)), minPx = Math.min(...pts.map((r) => r.px));
  const vMax = mode === 'track' ? Math.max(0.004, ...pts.map(val)) : Math.max(...pts.map(val));
  const vMin = mode === 'track' ? 0 : Math.min(...pts.map(val));
  const span = Math.max(0.001, vMax - vMin);

  const W = 640, H = 250, L = 58, R = 24, T = 20, B = 46;
  const x = (px) => L + (px - minPx) / Math.max(1, maxPx - minPx) * (W - L - R);
  // 两种模式都是「值越大越靠下」：字距是负得越多越下，行高是越松越上，所以行高要翻转
  const y = (r) => {
    const t = (val(r) - vMin) / span;
    return T + (mode === 'track' ? t : 1 - t) * (H - T - B);
  };

  const colors = ['var(--ink)', 'var(--mark)', 'var(--ink-mid)'];
  const series = usable.slice(0, 3).map((f, i) => {
    const rs = rows(f).slice().sort((a, b) => a.px - b.px);
    const line = rs.map((r) => `${x(r.px).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
    const dots = rs.map((r) => `<circle cx="${x(r.px).toFixed(1)}" cy="${y(r).toFixed(1)}" r="3.2" fill="${colors[i]}"/>`).join('');
    return `<polyline points="${line}" fill="none" stroke="${colors[i]}" stroke-width="${i === 0 ? 2 : 1.5}"${i ? ' stroke-dasharray="4 2.5"' : ''}/>${dots}`;
  }).join('');

  const legend = usable.slice(0, 3).map((f, i) => `
    <line x1="${W - 210}" y1="${40 + i * 17}" x2="${W - 184}" y2="${40 + i * 17}" stroke="${colors[i]}" stroke-width="2"${i ? ' stroke-dasharray="4 2.5"' : ''}/>
    <text x="${W - 178}" y="${44 + i * 17}" fill="${colors[i]}" font-size="11">--${esc(f.family)}-*（${rows(f).length}）</text>`).join('');

  const steps = mode === 'track' ? (A.typography.steps || []).map((st) => `
    <line x1="${x(st.to).toFixed(1)}" y1="${T - 8}" x2="${x(st.to).toFixed(1)}" y2="${H - B + 8}" stroke="var(--mark)" stroke-width="1" stroke-dasharray="3 3" opacity=".85"/>
    <text x="${(x(st.to) + 5).toFixed(1)}" y="${T + 14}" fill="var(--mark)" font-size="10.5">${st.to}px 台阶</text>`).join('') : '';

  const ticks = [...new Set(pts.map((r) => r.px))].sort((a, b) => a - b)
    .filter((_, i, arr) => arr.length <= 10 || i % Math.ceil(arr.length / 10) === 0)
    .map((px) => `<text x="${x(px).toFixed(1)}" y="${H - B + 26}" text-anchor="middle" font-size="10" fill="var(--ink-faint)">${px}</text>`).join('');

  const topLabel = mode === 'track' ? '0' : vMax.toFixed(2);
  const botLabel = mode === 'track' ? '-' + vMax.toFixed(3) : vMin.toFixed(2);
  const src = A.typography.curveSource === 'token' ? 'token 声明值' : '实测值（有噪音）';
  const title = mode === 'track' ? '字距曲线' : '行高曲线';
  const note = mode === 'track'
    ? `letter-spacing × font-size · ${src}`
    : `line-height ÷ font-size · ${src}`;
  const lede = mode === 'track'
    ? `把每套字号阶梯的负字距画出来。<b>规整的台阶说明有人设计过，抖成锯齿说明是各处随手写的。</b>
       一个系统可以有好几套平行阶梯，这里按 token 族分开画。`
    : `这个站的字距是独立命名的、不绑字号，所以字距图没有信息量 —— 改画行高比。
       <b>曲线往下走说明字越大排得越紧</b>，这是成熟排版系统的标志；走平说明所有字号共用一个行高。`;

  return section('02', title, note, `
    <p class="lede">${lede}</p>
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${mode === 'track' ? '字距' : '行高'}随字号变化">
        <g stroke="var(--rule)" stroke-width="1">
          <line x1="${L}" y1="${T}" x2="${W - R}" y2="${T}"/>
          <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
        </g>
        <text x="${L - 8}" y="${T + 4}" text-anchor="end" font-size="10" fill="var(--ink-faint)">${topLabel}</text>
        <text x="${L - 8}" y="${H - B + 4}" text-anchor="end" font-size="10" fill="var(--ink-faint)">${botLabel}</text>
        ${steps}${series}${legend}${ticks}
        <text x="${((L + W - R) / 2).toFixed(0)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--ink-mid)">font-size (px)</text>
      </svg>
    </div>`);
}

function typeSpecimens() {
  const rows = (A.typography?.curve || []).filter((r) => r.px >= 9).slice(-16).reverse();
  if (rows.length < 3) return '';
  const sample = 'The quick brown fox · 敏捷的棕色狐狸 · 0123456789';
  return section('03', '字体阶梯', `${rows.length} 档 · ${esc((A.typography.families || [])[0] || '').split(',')[0].replace(/"/g, '')}`, `
    <p class="lede">每一档都是 <b>字号 / 行高 / 字距 / 字重</b> 绑在一起的复合样式，不是四个独立变量。</p>
    <div class="specs">${rows.map((r) => {
    const w = r.weight || 400, lh = r.lhRatio || 1.4, tr = r.trackEm || 0;
    return `<div class="sp">
        <div class="tag"><b>${esc(r.token || r.px + 'px')}</b>${r.px}px / ${lh}<br>${tr ? tr + 'em' : '0'} · w${w}</div>
        <div class="demo" style="font-size:${Math.min(r.px, 56)}px;line-height:${lh};letter-spacing:${tr}em;font-weight:${w}">${esc(sample)}</div>
      </div>`;
  }).join('')}</div>`);
}

function palette() {
  const cols = A.colors || [];
  if (!cols.length) return '';
  const neutral = cols.filter((c) => c.oklch.C < 0.04).sort((a, b) => a.oklch.L - b.oklch.L).slice(0, 24);
  const chroma = cols.filter((c) => c.oklch.C >= 0.04).sort((a, b) => b.count - a.count).slice(0, 24);

  const chip = (c) => {
    const tk = tokenFor(c.hex);
    // 只有用量够大的野色才值得标红。渐变插值出来的一次性色追不到 token 是正常的，
    // 全标红会把「色板漏了」这条结论夸大好几倍。阈值跟漂移检测保持一致。
    const label = tk ? esc(tk) : (c.count >= 5 ? '追不到 token' : '—');
    const cls = tk ? '' : (c.count >= 5 ? ' rogue' : ' faint');
    return `<div class="chip">
      <div class="well" style="background:${c.hex}"></div>
      <div class="nm${cls}">${label}</div>
      <div class="hx">${c.hex}</div>
      <div class="ok">L${c.oklch.L} C${c.oklch.C.toFixed(4)} ${c.oklch.H === null ? '· 无色相' : 'H' + c.oklch.H}</div>
    </div>`;
  };

  const n = A.neutrals || {};
  const neutralNote = n.intentional
    ? `${n.tintedCount} 个中性色全部带彩度，色相聚在 ${(n.clusters || []).slice(0, 3).map((c) => c.hue + '°').join(' / ')}`
      + (n.brand ? `，品牌色在 ${n.brand.oklch.H}° —— 中性色是从品牌色派生的。` : '。')
    : `按明度排列。留意 C 值：等于 0 的是纯灰，不等于 0 的说明有人调过色相。`;

  return section('04', '色板', `${cols.length} 个实测色 · OKLCH`, `
    <p class="lede">每块色标下面是实测的 <b>OKLCH</b>（明度 / 彩度 / 色相）和它的 token 名。
    标红的是<b>追不到任何 token 的野色</b> —— 硬编码或第三方组件漏进来的。</p>
    ${neutral.length ? `<div class="swgroup"><h4>中性阶梯</h4><p>${esc(neutralNote)}</p><div class="sw">${neutral.map(chip).join('')}</div></div>` : ''}
    ${chroma.length ? `<div class="swgroup"><h4>有彩色</h4><p>按用量排序。成熟系统里这些色的明度和彩度会落在相近区间 —— 那样它们看起来才像一家人。</p><div class="sw">${chroma.map(chip).join('')}</div></div>` : ''}`);
}

function motion() {
  const eases = Object.entries(A.tokens?.motion || {}).filter(([k]) => /^--ease/i.test(k));
  const durs = A.motion?.durations || [];
  if (!eases.length && !durs.length) return '';

  const usedKeys = new Set((A.motion?.easings || []).map(([e]) => {
    const m = String(e).match(/cubic-bezier\(([^)]+)\)/i);
    return m ? 'cb:' + m[1].split(',').map((x) => +parseFloat(x).toFixed(4)).join(',') : String(e).trim();
  }));
  const key = (v) => {
    const m = String(v).match(/cubic-bezier\(([^)]+)\)/i);
    return m ? 'cb:' + m[1].split(',').map((x) => +parseFloat(x).toFixed(4)).join(',') : String(v).trim();
  };

  const grid = eases.length ? `<div class="ease">${eases.map(([k, v]) => {
    const m = String(v).match(/cubic-bezier\(([^)]+)\)/i);
    if (!m) return '';
    const [x1, y1, x2, y2] = m[1].split(',').map(parseFloat);
    const S = 64, used = usedKeys.has(key(v));
    const d = `M0,${S} C${(x1 * S).toFixed(1)},${((1 - y1) * S).toFixed(1)} ${(x2 * S).toFixed(1)},${((1 - y2) * S).toFixed(1)} ${S},0`;
    return `<div class="ez${used ? ' used' : ''}">
      <svg viewBox="-3 -3 ${S + 6} ${S + 6}" aria-hidden="true">
        <line x1="0" y1="${S}" x2="${S}" y2="0" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2 2"/>
        <path d="${d}" fill="none" stroke="${used ? 'var(--mark)' : 'var(--ink-mid)'}" stroke-width="${used ? 2.2 : 1.4}"/>
      </svg><div class="nm">${esc(k.replace(/^--ease-?/, ''))}${used ? '<br>在用' : ''}</div></div>`;
  }).join('')}</div>` : '';

  const declared = new Set(Object.entries(A.tokens?.motion || {})
    .filter(([k]) => /speed|duration/i.test(k))
    .map(([, v]) => +parseFloat(v).toFixed(4)));
  const max = Math.max(...durs.map(([, n]) => n), 1);
  const ladder = durs.length ? `<div class="ladder">${durs.slice(0, 10).map(([d, n]) => {
    const inTok = declared.has(+parseFloat(d).toFixed(4));
    return `<div class="rung"><span class="v">${esc(d)}</span>
      <span class="bar" style="width:${Math.max(2, n / max * 100).toFixed(1)}%"></span>
      <span class="n">${n}× · ${inTok ? '在 token 表内' : '<b class="rogue">表外</b>'}</span></div>`;
  }).join('')}</div>` : '';

  const usedCount = eases.filter(([, v]) => usedKeys.has(key(v))).length;
  return section('05', '动效', eases.length ? `定义 ${eases.length} 条缓动 · 实测在用 ${usedCount} 条` : '实测时长分布', `
    <p class="lede">缓动曲线画出来最诚实：<b>红色的是页面上真正检测到在用的</b>，灰色的是定义了没人用的死库存。
    下面的时长表标出了哪些值根本不在 token 里 —— 那是系统和实现分家的地方。</p>
    ${grid}
    ${ladder ? `<h4 class="sub-h">时长实测</h4>${ladder}` : ''}`);
}

function layers() {
  const tk = Object.entries(A.tokens?.layer || {})
    .map(([k, v]) => [k, parseInt(v, 10)]).filter(([, v]) => !isNaN(v)).sort((a, b) => a[1] - b[1]);
  const rows = tk.length >= 4 ? tk : (A.layers || []).map(([v, n]) => [`实测 ${n} 处`, parseInt(v, 10)])
    .filter(([, v]) => !isNaN(v)).sort((a, b) => a[1] - b[1]);
  if (rows.length < 3) return '';
  const max = Math.max(...rows.map(([, v]) => Math.abs(v)), 1);
  return section('06', '层级梯', `${rows.length} 层${tk.length >= 4 ? ' · 语义命名' : ' · 仅实测'}`, `
    <p class="lede">${tk.length >= 4
      ? '全部语义命名，没有裸写数字。留意档位之间留了多大空隙 —— <b>留白也可以留在数值里</b>。'
      : '这个站没有把层级抽成 token，下面是实测出现的 z-index 值。裸写数字多说明层级管理是即兴的。'}</p>
    <div class="ladder">${rows.map(([k, v]) => `
      <div class="rung"><span class="v">${v}</span>
        <span class="bar" style="width:${(Math.pow(Math.abs(v) / max, 0.28) * 100).toFixed(1)}%"></span>
        <span class="n">${esc(k)}</span></div>`).join('')}</div>`);
}

function shapes() {
  const radii = (A.radii || []).slice(0, 10);
  const sp = (A.spacing?.measured || []).slice(0, 10);
  if (!radii.length && !sp.length) return '';
  const base = A.spacing?.base || 0;
  const maxSp = Math.max(...sp.map(([, n]) => n), 1);

  return section('07', '形状与尺度', base ? `间距基数 ${base}px · 覆盖 ${pct(A.spacing.coverage)}%` : '未检出间距网格', `
    <p class="lede">${base
      ? `实测间距有 ${pct(A.spacing.coverage)}% 落在 ${base} 的倍数上。<b>剩下那些不在网格上的值</b>，少量是光学微调，成片出现就是网格没守住。`
      : '实测间距没有可辨认的基数网格 —— 这本身就是一条结论：这个站的间距是一处一处写出来的，不是从一个系统里取的。'}</p>
    ${radii.length ? `<div class="swgroup"><h4>圆角</h4><div class="strip">${radii.map(([r, n]) => `
      <div class="cell"><div class="box" style="border-radius:${esc(r)}"></div><div class="lb">${esc(r)}</div><div class="lb dim">${n}×</div></div>`).join('')}</div></div>` : ''}
    ${sp.length ? `<div class="swgroup"><h4>间距频次</h4><div class="ladder">${sp.map(([v, n]) => {
      const off = base && +v % base !== 0;
      return `<div class="rung"><span class="v">${v}px</span>
        <span class="bar" style="width:${(n / maxSp * 100).toFixed(1)}%"></span>
        <span class="n">${n}×${off ? ' · <b class="rogue">离网格</b>' : ''}</span></div>`;
    }).join('')}</div></div>` : ''}`);
}

function tokenDump() {
  const cats = [['type', '排版'], ['color', '颜色'], ['motion', '动效'], ['radius', '圆角'], ['layer', '层级'], ['shadow', '阴影'], ['size', '尺寸']];
  const blocks = cats.map(([k, label]) => {
    const entries = Object.entries(A.tokens?.[k] || {}).slice(0, 14);
    if (!entries.length) return '';
    return `<span class="c">/* ${label} · ${Object.keys(A.tokens[k]).length} 个 */</span>\n`
      + entries.map(([n, v]) => `<span class="k">${esc(n)}</span>: ${esc(String(v).slice(0, 76))}`).join('\n');
  }).filter(Boolean);
  if (!blocks.length) return '';
  return section('08', '可直接带走的部分', `${A.tokenCount} 个 token 节选`, `
    <p class="lede">不是让你抄配色 —— 配色是人家的。值得抄的是<b>结构</b>：复合文字样式、语义层级、按明度分级的背景阶梯。</p>
    <pre class="tok">${blocks.join('\n\n')}</pre>`);
}

function section(no, title, note, body) {
  return `<section class="plate">
    <div class="plate-hd"><span class="plate-no">${no}</span><h2>${esc(title)}</h2><span class="note">${esc(note)}</span></div>
    ${body}
  </section>`;
}

// ── 组装 ──────────────────────────────────────────────────────
const conf = A.confidence || { level: '?', label: '未知', note: '' };
const m = A.meta || {};

const body = [findings(), trackingChart(), typeSpecimens(), palette(), motion(), layers(), shapes(), tokenDump()]
  .filter(Boolean).join('\n');

const html = `<title>${esc(host)} 设计解剖</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --paper:#E9EBEE; --plate:#F2F3F5; --ink:#16181F; --ink-mid:#5C6270; --ink-faint:#9198A4;
  --rule:#C4C8CF; --rule-soft:#D8DBE0; --mark:${MARK_LIGHT}; --mark-soft:color-mix(in srgb, ${MARK_LIGHT} 13%, transparent);
  --chip-edge:#00000026;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#0A0B0D; --plate:#101216; --ink:#E4E6EA; --ink-mid:#8E96A4; --ink-faint:#5C6472;
  --rule:#262A31; --rule-soft:#1B1E24; --mark:${MARK_DARK}; --mark-soft:color-mix(in srgb, ${MARK_DARK} 16%, transparent);
  --chip-edge:#FFFFFF2E;
}}
:root[data-theme="dark"]{
  --paper:#0A0B0D; --plate:#101216; --ink:#E4E6EA; --ink-mid:#8E96A4; --ink-faint:#5C6472;
  --rule:#262A31; --rule-soft:#1B1E24; --mark:${MARK_DARK}; --mark-soft:color-mix(in srgb, ${MARK_DARK} 16%, transparent);
  --chip-edge:#FFFFFF2E;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Archivo","Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:56px 28px 96px}
.mast{border-bottom:2px solid var(--ink);padding-bottom:20px}
.mast-top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.spec{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mark)}
h1{font-size:clamp(36px,7vw,64px);font-weight:700;letter-spacing:-.035em;line-height:1.03;margin:14px 0 0;text-wrap:balance}
.sub{color:var(--ink-mid);max-width:62ch;margin:12px 0 0;font-size:16px}
.conf{display:inline-flex;align-items:center;gap:9px;margin-top:18px;border:1px solid var(--rule);background:var(--plate);padding:9px 14px}
.conf .lv{font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:15px;color:var(--paper);background:var(--mark);padding:2px 8px}
.conf .tx{font-size:13.5px;color:var(--ink-mid);max-width:64ch}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(124px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin-top:26px}
.meta div{background:var(--paper);padding:11px 13px}
.meta dt{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint);margin:0}
.meta dd{margin:3px 0 0;font-family:"IBM Plex Mono",monospace;font-size:17px;font-weight:500;font-variant-numeric:tabular-nums}
.plate{margin-top:60px}
.plate-hd{display:flex;align-items:baseline;gap:14px;border-bottom:1px solid var(--ink);padding-bottom:8px;flex-wrap:wrap}
.plate-no{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:600;letter-spacing:.1em;color:var(--paper);background:var(--ink);padding:3px 7px}
.plate-hd h2{font-size:23px;font-weight:600;letter-spacing:-.02em;margin:0;flex:1}
.plate-hd .note{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-faint)}
.lede{color:var(--ink-mid);margin:16px 0 24px;max-width:68ch}
.lede b{color:var(--ink);font-weight:600}
.sub-h{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-faint);margin:26px 0 10px}
code{font-family:"IBM Plex Mono",monospace;font-size:12.5px;background:var(--mark-soft);color:var(--mark);padding:1px 5px}
.finds{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule)}
.find{background:var(--plate);padding:17px 20px;display:grid;grid-template-columns:52px 1fr;gap:16px;align-items:start}
.find .idx{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:600;color:var(--ink-faint);padding-top:4px}
.find .kind{display:block;font-size:9.5px;font-weight:600;margin-top:5px;letter-spacing:.06em}
.find .kind.drift{color:var(--mark)}
.find h3{margin:0 0 5px;font-size:16px;font-weight:600;letter-spacing:-.012em}
.find p{margin:0;color:var(--ink-mid);font-size:14.5px}
.swgroup{margin-bottom:28px}
.swgroup>h4{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 3px}
.swgroup>p{margin:0 0 12px;font-size:13.5px;color:var(--ink-mid)}
.sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}
.chip{background:var(--plate);padding:9px}
.chip .well{height:42px;border:1px solid var(--chip-edge);margin-bottom:8px}
.chip .nm{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink);word-break:break-all;line-height:1.35}
.chip .nm.rogue{color:var(--mark)}
.chip .nm.faint{color:var(--ink-faint)}
.chip .hx{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-faint);margin-top:2px}
.chip .ok{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--mark);margin-top:4px;font-variant-numeric:tabular-nums}
.specs{display:grid;gap:1px;background:var(--rule);border:1px solid var(--rule)}
.sp{background:var(--plate);padding:14px 20px;display:grid;grid-template-columns:104px 1fr;gap:20px;align-items:baseline}
.sp .tag{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-faint);line-height:1.5;padding-top:6px;word-break:break-all}
.sp .tag b{display:block;color:var(--mark);font-weight:500}
.sp .demo{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.chart{border:1px solid var(--rule);background:var(--plate);padding:20px;overflow-x:auto}
.chart svg{display:block;min-width:560px;width:100%;height:auto}
.ease{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule)}
.ez{background:var(--plate);padding:10px;text-align:center}
.ez.used{background:var(--mark-soft)}
.ez svg{display:block;width:100%;height:auto}
.ez .nm{font-family:"IBM Plex Mono",monospace;font-size:9.5px;color:var(--ink-mid);margin-top:6px;word-break:break-all}
.ez.used .nm{color:var(--mark);font-weight:600}
.ladder{border:1px solid var(--rule);background:var(--plate)}
.rung{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:6px 16px;border-bottom:1px solid var(--rule-soft)}
.rung:last-child{border-bottom:0}
.rung .v{font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-weight:500;font-variant-numeric:tabular-nums;width:60px;text-align:right}
.rung .bar{height:3px;background:var(--mark);opacity:.75}
.rung .n{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-mid)}
.rung .rogue{color:var(--mark);font-weight:600}
.strip{display:flex;flex-wrap:wrap;gap:1px;background:var(--rule);border:1px solid var(--rule)}
.strip .cell{background:var(--plate);padding:14px 16px;flex:1 1 94px;text-align:center}
.strip .cell .box{width:44px;height:44px;margin:0 auto 9px;background:var(--ink);opacity:.85}
.strip .cell .lb{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-mid);font-variant-numeric:tabular-nums}
.strip .cell .lb.dim{color:var(--ink-faint);font-size:10px}
pre.tok{font-family:"IBM Plex Mono",monospace;font-size:12px;line-height:1.75;background:var(--plate);border:1px solid var(--rule);padding:18px 20px;overflow-x:auto;margin:0;color:var(--ink-mid)}
pre.tok .k{color:var(--ink)}
pre.tok .c{color:var(--mark)}
footer{margin-top:70px;border-top:2px solid var(--ink);padding-top:16px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer p{margin:0;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-faint);letter-spacing:.04em}
@media (max-width:620px){
  .sp{grid-template-columns:1fr;gap:6px}.sp .tag{padding-top:0}
  .find{grid-template-columns:1fr;gap:6px}.find .idx{padding-top:0}
  .find .kind{display:inline;margin-left:8px}
}
</style>

<div class="wrap">
  <header class="mast">
    <div class="mast-top">
      <span class="spec">Teardown · ${esc(host)}</span>
      <span class="spec">${esc((A.capturedAt || '').slice(0, 10))} · ${esc(m.requestedViewport || m.capturedViewport?.w + 'x' + m.capturedViewport?.h || '')} · ${esc(m.requestedTheme || m.colorScheme || '')}</span>
    </div>
    <h1>${esc(host)} 设计解剖</h1>
    <p class="sub">不看截图，不问设计师。把页面的 CSSOM 整个抓下来，量它的每一个数 ——
    ${m.semanticVarCount || 0} 个语义 token、${m.elementsScanned || 0} 个可见元素、每一处颜色、字距、缓动与层级。</p>
    <div class="conf"><span class="lv">${esc(conf.level)}</span><span class="tx"><b>${esc(conf.label)}</b> · ${esc(conf.note)}</span></div>
    <dl class="meta">
      <div><dt>语义 Token</dt><dd>${m.semanticVarCount || 0}</dd></div>
      <div><dt>可见元素</dt><dd>${m.elementsScanned || 0}</dd></div>
      <div><dt>实测色</dt><dd>${(A.colors || []).length}</dd></div>
      <div><dt>字体族</dt><dd>${(A.fonts || []).length}</dd></div>
      <div><dt>发现</dt><dd>${(A.findings || []).length}</dd></div>
      <div><dt>其中漂移</dt><dd>${(A.findings || []).filter((f) => f.kind === 'drift').length}</dd></div>
    </dl>
  </header>
${body}
  <footer>
    <p>抓取方式：CSSOM 遍历 + getComputedStyle，无截图、无视觉模型${m.stylesheetsBlocked ? ` · ${m.stylesheetsBlocked} 张跨域样式表读不到，交互态可能不全` : ''}</p>
    <p>web-teardown</p>
  </footer>
</div>
`;

const outPath = resolve(flag('out', `./teardown-${host}.html`));
writeFileSync(outPath, html);
console.log(outPath);
