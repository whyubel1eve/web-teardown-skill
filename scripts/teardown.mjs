#!/usr/bin/env node
/**
 * web-teardown · 通道 C：本机 Chrome 全自动采集
 *
 * 拉起 headless Chrome，用 CDP 注入 assets/probe.js，滚完整页后取回 JSON。
 * 比手工粘贴强的地方：能滚动触发懒加载、能切视口、能切明暗主题、能一次跑多组。
 *
 * 用法：
 *   node teardown.mjs <url> [选项]
 *
 *   --out <file>        输出 JSON 路径（默认 ./teardown-<host>.json）
 *   --viewport <WxH>    视口，可重复传（默认 1440x900）
 *   --theme <t>         light | dark | both（默认 both，站点只有一套时自动去重）
 *   --wait <ms>         load 之后额外等多久（默认 1500，给动画和懒加载留时间）
 *   --no-scroll         不滚动（快，但会漏掉懒加载的内容）
 *   --keep-open         采完不关浏览器，方便自己接着看
 *
 * 依赖：Node ≥ 22（要 global WebSocket）+ 本机 Chrome / Edge / Chromium。
 * 不满足就走通道 A（控制台粘贴），见 references/channels.md。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = readFileSync(join(HERE, '..', 'assets', 'probe.js'), 'utf8');

if (typeof WebSocket !== 'function') {
  console.error('这条通道需要 Node ≥ 22（global WebSocket）。当前：' + process.version);
  console.error('改走通道 A：把 assets/probe.js 贴进浏览器控制台。见 references/channels.md');
  process.exit(1);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

// ── 参数 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const all = (n) => argv.reduce((acc, a, i) => (a === '--' + n && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const VALUED = ['out', 'viewport', 'theme', 'wait'];
const taken = new Set();
argv.forEach((a, i) => { if (VALUED.some((v) => a === '--' + v)) taken.add(i + 1); });
const url = argv.find((a, i) => !taken.has(i) && !a.startsWith('--'));

if (!url) {
  console.error('用法: node teardown.mjs <url> [--out f.json] [--viewport 1440x900] [--theme both]');
  process.exit(1);
}
const target = /^https?:\/\//.test(url) ? url : 'https://' + url;
const host = new URL(target).hostname.replace(/^www\./, '');

const viewports = (all('viewport').length ? all('viewport') : ['1440x900']).map((v) => {
  const [w, h] = v.split('x').map(Number);
  if (!w || !h) { console.error('视口格式应为 WxH，比如 1440x900'); process.exit(1); }
  return { w, h, label: v };
});
const themeArg = flag('theme', 'both');
const themes = themeArg === 'both' ? ['light', 'dark'] : [themeArg];
const waitMs = Number(flag('wait', 1500));
const doScroll = !has('no-scroll');
const outPath = resolve(flag('out', `./teardown-${host}.json`));

// ── 极简 CDP 客户端 ───────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: no } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((ok, no) => {
      this.pending.set(id, { resolve: ok, reject: no });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); no(new Error(`CDP 超时: ${method}`)); }
      }, 45000);
    });
  }
  waitFor(method, sessionId, timeout = 30000) {
    return new Promise((ok) => {
      const t = setTimeout(ok, timeout);            // 超时就放行，别把整轮卡死
      const prev = this.onEvent;
      this.onEvent = (msg) => {
        prev?.(msg);
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(t); this.onEvent = prev; ok();
        }
      };
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 拉起 Chrome ───────────────────────────────────────────────
function launchChrome() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) {
    console.error('找不到 Chrome。设置 CHROME_PATH，或改走通道 A（控制台粘贴）。');
    process.exit(1);
  }
  const profile = mkdtempSync(join(tmpdir(), 'wtd-'));
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--no-service-autorun',
    '--disable-sync', '--disable-default-apps', '--metrics-recording-only', '--mute-audio',
    '--hide-scrollbars', '--disable-gpu',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = new Promise((ok, no) => {
    let buf = '';
    const t = setTimeout(() => no(new Error('Chrome 起了但没吐 DevTools 地址')), 20000);
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); ok(m[0]); }
    });
    child.on('exit', (c) => { clearTimeout(t); no(new Error('Chrome 退出了，code=' + c)); });
  });
  return { child, profile, wsUrl };
}

// ── 采一轮 ────────────────────────────────────────────────────
async function capture(cdp, { w, h, label }, theme) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);

  const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url: target }, sessionId);
  await loaded;
  await sleep(waitMs);

  // 滚一遍：懒加载、进场动画、IntersectionObserver 挂着的内容都得先触发
  if (doScroll) {
    await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{
        const step = innerHeight * 0.8;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          scrollTo(0, y); await new Promise(r => setTimeout(r, 220));
        }
        scrollTo(0, 0); await new Promise(r => setTimeout(r, 400));
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId).catch(() => { /* 滚动失败不致命，继续采 */ });
  }

  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression: `${PROBE}; JSON.stringify(window.__TEARDOWN__())`,
    returnByValue: true, timeout: 40000,
  }, sessionId);

  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});

  if (exceptionDetails) throw new Error('提取器报错: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  if (typeof result?.value !== 'string') throw new Error('提取器没有返回数据（页面可能拦了脚本执行）');

  const data = JSON.parse(result.value);
  data.meta.requestedViewport = label;
  data.meta.requestedTheme = theme;
  return data;
}

// ── 主流程 ────────────────────────────────────────────────────
const { child, profile, wsUrl } = launchChrome();
let cdp;
try {
  cdp = new CDP(await wsUrl);
  await cdp.ready;

  const passes = [];
  for (const vp of viewports) {
    for (const theme of themes) {
      process.stderr.write(`采集 ${vp.label} / ${theme} … `);
      try {
        const data = await capture(cdp, vp, theme);
        passes.push(data);
        process.stderr.write(`${data.meta.elementsScanned} 元素, ${data.meta.semanticVarCount} token\n`);
      } catch (err) {
        process.stderr.write(`失败：${err.message}\n`);
      }
    }
  }

  if (!passes.length) { console.error('一轮都没采到，检查 URL 是否可达。'); process.exit(1); }

  // 明暗两轮完全一致说明站点没有主题切换，留一轮就够，别在报告里假装有两套
  if (passes.length >= 2 && themes.length === 2) {
    const sig = (p) => JSON.stringify(p.colors.slice(0, 12).map((c) => c.hex));
    for (let i = passes.length - 1; i > 0; i--) {
      if (passes[i].meta.requestedViewport === passes[i - 1].meta.requestedViewport
        && sig(passes[i]) === sig(passes[i - 1])) {
        passes[i - 1].meta.themeAgnostic = true;
        passes.splice(i, 1);
      }
    }
  }

  const out = {
    tool: 'web-teardown',
    version: 1,
    target,
    capturedAt: new Date().toISOString(),
    channel: 'cdp',
    passes,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(outPath);
} catch (err) {
  console.error('采集失败：' + err.message);
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (!has('keep-open')) {
    try { child.kill('SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
