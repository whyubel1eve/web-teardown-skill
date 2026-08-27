#!/usr/bin/env node
/**
 * web-teardown · 自检
 *
 * 不联网、不开浏览器，用一份构造好的数据把 analyze → report 跑一遍。
 * 这份数据里**故意埋了每一种漂移**，所以自检同时也是检测器的回归测试：
 * 哪条检测失灵了，这里就会红。
 *
 * 用法：node selftest.mjs [输出目录]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'wtd-test-'));
mkdirSync(OUT, { recursive: true });   // 传进来的目录不一定存在

// ── 构造数据：每一种漂移各埋一个 ──────────────────────────────
const fixture = {
  tool: 'web-teardown', version: 1,
  target: 'https://example.com', capturedAt: '2026-01-01T00:00:00.000Z', channel: 'fixture',
  passes: [{
    meta: {
      url: 'https://example.com/', origin: 'https://example.com', title: 'Fixture',
      capturedViewport: { w: 1440, h: 900 }, scrollHeight: 4000, dpr: 1, colorScheme: 'dark',
      elementsScanned: 1200, elementsSkipped: 300, elementsTotal: 1500, truncated: false,
      semanticVarCount: 64, noiseVarCount: 12, stylesheetsRead: 4, stylesheetsBlocked: 1,
      requestedViewport: '1440x900', requestedTheme: 'dark',
    },
    vars: {
      // 品牌色（用来验证「品牌色优先信 token 命名」）
      '--color-accent': '#5e6ad2',
      '--color-bg-primary': '#0a0b0d', '--color-bg-level-1': '#111318',
      '--color-bg-level-2': '#171a20', '--color-bg-level-3': '#1d2028',
      '--color-bg-quinary': '#2b2b2b',          // 埋点：唯一的纯灰
      '--color-text-primary': '#f2f3f6', '--color-text-secondary': '#c8cede',
      '--color-text-tertiary': '#868c9b', '--color-green': '#27a644', '--color-red': '#eb5757',
      // 埋点：定义 4 条缓动，实测只用 1 条
      '--ease-out-quad': 'cubic-bezier(.25, .46, .45, .94)',
      '--ease-in-quad': 'cubic-bezier(.55, .085, .68, .53)',
      '--ease-out-expo': 'cubic-bezier(.19, 1, .22, 1)',
      '--ease-in-out-quart': 'cubic-bezier(.77, 0, .175, 1)',
      // 埋点：token 只有 3 档时长，实测会跑出表外的 0.16s
      '--speed-quick': '.1s', '--speed-regular': '.25s', '--speed-slow': '.4s',
      // 两套平行字号阶梯（用来验证「按族分开算台阶」）
      '--text-tiny-size': '.625rem', '--text-tiny-letter-spacing': '-.015em', '--text-tiny-line-height': '1.5',
      '--text-mini-size': '.8125rem', '--text-mini-letter-spacing': '-.01em', '--text-mini-line-height': '1.5',
      '--text-regular-size': '.9375rem', '--text-regular-letter-spacing': '-.011em', '--text-regular-line-height': '1.6',
      '--text-large-size': '1.0625rem', '--text-large-letter-spacing': '0', '--text-large-line-height': '1.6',
      '--title-1-size': '1.25rem', '--title-1-letter-spacing': '-.012em', '--title-1-line-height': '1.4',
      '--title-2-size': '1.5rem', '--title-2-letter-spacing': '-.012em', '--title-2-line-height': '1.33',
      '--title-3-size': '2rem', '--title-3-letter-spacing': '-.022em', '--title-3-line-height': '1.125',
      '--title-4-size': '3rem', '--title-4-letter-spacing': '-.022em', '--title-4-line-height': '1',
      '--title-5-size': '4rem', '--title-5-letter-spacing': '-.022em', '--title-5-line-height': '1',
      '--font-weight-medium': '510', '--font-weight-semibold': '590',
      // Tailwind v4 写法：裸长度值 + 双短横线修饰符，且行高是 calc 比值
      '--text-tw-xs': '.75rem', '--text-tw-xs--line-height': 'calc(1 / .75)',
      '--text-tw-sm': '.875rem', '--text-tw-sm--line-height': 'calc(1.25 / .875)',
      '--text-tw-base': '1rem', '--text-tw-base--line-height': 'calc(1.5 / 1)',
      '--text-tw-2xl': '1.5rem', '--text-tw-2xl--line-height': 'calc(2 / 1.5)',
      '--text-tw-5xl': '3rem', '--text-tw-5xl--line-height': '1',
      // 这两个必须被排除在字号阶梯之外 —— 它们是尺寸，不是字号
      '--scrollbar-size': '6px', '--min-tap-size': '44px',
      // 这个也必须排除：--text-* 开头但值不是纯长度
      '--text-shadow-sm': '0px 1px 0px #00000013',
      '--font-settings': '"cv01", "ss03"', '--font-variations': '"opsz" auto',
      '--radius-4': '4px', '--radius-8': '8px', '--radius-12': '12px',
      '--shadow-low': '0px 2px 4px #0000001a', '--shadow-high': '0px 7px 32px #00000059',
      '--layer-footer': '50', '--layer-header': '100', '--layer-overlay': '500',
      '--layer-dialog-overlay': '699', '--layer-dialog': '700', '--layer-tooltip': '1100',
      '--layer-max': '10000',
      '--prose-max-width': '624px',
    },
    colors: [
      // 中性阶梯：全部带蓝紫彩度，聚在 270° 附近（品牌色 275°）
      { hex: '#0a0b0d', count: 800, oklch: { L: 15.1, C: 0.0043, H: 265.2 }, role: 'bg', roles: { text: 0, bg: 800, border: 0 } },
      { hex: '#111318', count: 400, oklch: { L: 19.4, C: 0.0092, H: 268.1 }, role: 'bg', roles: { text: 0, bg: 400, border: 0 } },
      { hex: '#171a20', count: 200, oklch: { L: 22.8, C: 0.0114, H: 269.4 }, role: 'bg', roles: { text: 0, bg: 200, border: 0 } },
      { hex: '#1d2028', count: 120, oklch: { L: 26.1, C: 0.0138, H: 270.3 }, role: 'bg', roles: { text: 0, bg: 120, border: 0 } },
      { hex: '#2b2b2b', count: 40, oklch: { L: 29.4, C: 0.0000, H: null }, role: 'bg', roles: { text: 0, bg: 40, border: 0 } },
      { hex: '#868c9b', count: 150, oklch: { L: 62.4, C: 0.0198, H: 271.1 }, role: 'text', roles: { text: 150, bg: 0, border: 0 } },
      { hex: '#c8cede', count: 180, oklch: { L: 84.6, C: 0.0221, H: 272.5 }, role: 'text', roles: { text: 180, bg: 0, border: 0 } },
      { hex: '#f2f3f6', count: 300, oklch: { L: 95.9, C: 0.0037, H: 274.0 }, role: 'text', roles: { text: 300, bg: 0, border: 0 } },
      { hex: '#ffffff', count: 90, oklch: { L: 100, C: 0, H: null }, role: 'text', roles: { text: 90, bg: 0, border: 0 } },
      // 有彩色
      { hex: '#5e6ad2', count: 60, oklch: { L: 56.7, C: 0.1585, H: 275.2 }, role: 'bg', roles: { text: 0, bg: 60, border: 0 } },
      { hex: '#27a644', count: 30, oklch: { L: 63.7, C: 0.1749, H: 146.7 }, role: 'bg', roles: { text: 0, bg: 30, border: 0 } },
      { hex: '#eb5757', count: 25, oklch: { L: 65.3, C: 0.1835, H: 23.7 }, role: 'bg', roles: { text: 0, bg: 25, border: 0 } },
      // 埋点：三个追不到 token 的野色，且 count ≥ 5
      { hex: '#ff00aa', count: 22, oklch: { L: 60.1, C: 0.2810, H: 349.2 }, role: 'bg', roles: { text: 0, bg: 22, border: 0 } },
      { hex: '#123456', count: 14, oklch: { L: 27.7, C: 0.0512, H: 262.8 }, role: 'bg', roles: { text: 0, bg: 14, border: 0 } },
      { hex: '#abcdef', count: 9, oklch: { L: 83.2, C: 0.0521, H: 258.4 }, role: 'text', roles: { text: 9, bg: 0, border: 0 } },
    ],
    textStyles: [
      { family: 'sans', size: '15px', weight: '400', lineHeight: '24px', tracking: '-0.165px', transform: 'none', px: 15, lhRatio: 1.6, trackEm: -0.011, count: 120, topTag: 'P', sample: 'Body copy' },
      { family: 'sans', size: '13px', weight: '510', lineHeight: '19.5px', tracking: '-0.13px', transform: 'none', px: 13, lhRatio: 1.5, trackEm: -0.01, count: 80, topTag: 'SPAN', sample: 'Label' },
      { family: 'sans', size: '48px', weight: '590', lineHeight: '48px', tracking: '-1.056px', transform: 'none', px: 48, lhRatio: 1, trackEm: -0.022, count: 6, topTag: 'H1', sample: 'Headline' },
      { family: 'mono', size: '12px', weight: '400', lineHeight: '16.8px', tracking: 'normal', transform: 'none', px: 12, lhRatio: 1.4, trackEm: 0, count: 40, topTag: 'CODE', sample: 'const x' },
    ],
    fonts: [['"Inter Variable", sans-serif', 300], ['"Berkeley Mono", monospace', 60]],
    radii: [['4px', 60], ['8px', 40], ['12px', 20], ['9999px', 15], ['50%', 10]],
    shadows: [['rgba(0, 0, 0, 0.1) 0px 2px 4px 0px', 30]],
    borderWidths: [['1px', 90]],
    // 埋点：0.16s 不在 token 表；.1s 在（验证前导零归一化：token 写 `.1s`，实测是 `0.1s`）
    durations: [['0.16s', 90], ['0.1s', 50], ['0.25s', 30], ['0.3s', 12], ['2.4s', 20]],
    easings: [['cubic-bezier(0.25, 0.46, 0.45, 0.94)', 95], ['ease', 20]],
    transforms: [['matrix(1, 0, 0, 1, 0, 0)', 40]],
    filters: [['backdrop:blur(20px)', 6]],
    // 埋点：基数 4，但 6/19/22 离网格
    spacing: [[8, 200], [16, 150], [24, 120], [32, 100], [4, 80], [6, 40], [12, 60], [19, 25], [22, 20], [48, 30]],
    gaps: [[8, 90], [12, 40], [4, 30]],
    zIndex: [['1', 10], ['100', 4], ['700', 2]],
    states: {
      hover: [['background-color', 40], ['opacity', 25], ['color', 20], ['border-color', 10]],
      focus: [['outline', 15], ['box-shadow', 8]],
      active: [['opacity', 6]], dataState: [['background-color', 5]],
    },
  }],
};

const tdPath = join(OUT, 'selftest-teardown.json');
const anPath = join(OUT, 'selftest-analysis.json');
const rpPath = join(OUT, 'selftest-report.html');
writeFileSync(tdPath, JSON.stringify(fixture, null, 2));

const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${script} 退出码 ${r.status}\n${r.stderr || r.stdout}`);
  return r;
};

// ── 跑 ────────────────────────────────────────────────────────
const fails = [];
const check = (label, ok, detail) => { if (!ok) fails.push(`${label}${detail ? ' — ' + detail : ''}`); };

try {
  run('analyze.mjs', [tdPath, '--out', anPath]);
  const A = JSON.parse(readFileSync(anPath, 'utf8'));

  check('置信度应为 A', A.confidence.level === 'A', `实际 ${A.confidence.level}`);

  // 品牌色必须来自 --color-accent，而不是彩度最高的 #ff00aa
  check('品牌色应取 token 声明值 #5e6ad2', A.neutrals.brand?.hex === '#5e6ad2',
    `实际 ${A.neutrals.brand?.hex}`);

  // 纯白必须排除，只留 #2b2b2b
  check('纯灰只应识别出 #2b2b2b', JSON.stringify(A.neutrals.pureGreys) === '["#2b2b2b"]',
    `实际 ${JSON.stringify(A.neutrals.pureGreys)}`);

  check('中性色应判定为有意派生', A.neutrals.intentional === true);

  check('字距曲线应读 token', A.typography.curveSource === 'token', `实际 ${A.typography.curveSource}`);
  // fixture 里有三套平行阶梯：--text-*（后缀式）、--title-*（后缀式）、--text-tw-*（Tailwind 写法）
  const famNames = A.typography.familyCurves.map((f) => f.family).sort().join(',');
  check('应拆出 text / text-tw / title 三族', famNames === 'text,text-tw,title', `实际 ${famNames}`);
  check('title 族应检出 1 个台阶',
    A.typography.steps.filter((s) => s.family === 'title').length === 1,
    `实际 ${JSON.stringify(A.typography.steps)}`);

  check('间距基数应为 4', A.spacing.base === 4, `实际 ${A.spacing.base}`);

  // Tailwind v4 写法必须被解析出来
  const tw = A.typography.curve.filter((r) => /^--text-tw-/.test(r.token));
  check('应解析出 5 档 Tailwind 写法的字号', tw.length === 5, `实际 ${tw.length}`);
  const twSm = tw.find((r) => r.token === '--text-tw-sm');
  check('--text-tw-sm 应为 14px', twSm && twSm.px === 14, `实际 ${twSm?.px}`);
  check('calc(1.25 / .875) 应求值为 1.429',
    twSm && Math.abs(twSm.lhRatio - 1.429) < 0.002, `实际 ${twSm?.lhRatio}`);

  // 尺寸 token 不许混进字号阶梯
  const bogus = A.typography.curve.filter((r) => /scrollbar|tap|shadow/.test(r.token || ''));
  check('尺寸/阴影 token 不应混进字号阶梯', bogus.length === 0,
    `混进了 ${bogus.map((r) => r.token).join(',')}`);

  const ids = new Set(A.findings.map((f) => f.id));
  for (const id of ['duration-rogue', 'ease-deadstock', 'color-rogue', 'neutral-outlier', 'space-offgrid']) {
    check(`应检出漂移 ${id}`, ids.has(id));
  }
  for (const id of ['weights-off-hundred', 'tracking-step', 'neutrals-tinted', 'font-features', 'layer-semantics']) {
    check(`应检出 ${id}`, ids.has(id));
  }

  // 前导零归一化：.1s（token）和 0.1s（实测）是同一个值，不能被当成漂移
  const dr = A.findings.find((f) => f.id === 'duration-rogue');
  check('0.1s 不应被误报为表外时长',
    dr && !dr.data.rogue.some(([d]) => d === '0.1s'), JSON.stringify(dr?.data.rogue));

  // 4 条缓动定义，实测在用 1 条
  const ez = A.findings.find((f) => f.id === 'ease-deadstock');
  check('缓动应识别出 1 条在用', ez && ez.data.used.length === 1, JSON.stringify(ez?.data.used));

  run('report.mjs', [anPath, '--out', rpPath]);
  const html = readFileSync(rpPath, 'utf8');
  check('报告应有 8 个 plate', (html.match(/class="plate-no"/g) || []).length === 8,
    `实际 ${(html.match(/class="plate-no"/g) || []).length}`);
  check('报告不应有未解析的模板值', !/undefined|NaN|\[object Object\]/.test(html));
  check('报告应含置信度徽章', html.includes('class="conf"'));
  check('报告应含深色主题 token', html.includes('prefers-color-scheme:dark'));
} catch (err) {
  fails.push('管线异常 — ' + err.message);
}

if (fails.length) {
  console.error('自检失败：\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
console.log(`自检通过 · ${rpPath}`);
