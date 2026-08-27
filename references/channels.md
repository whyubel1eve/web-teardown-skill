# 采集通道

三条通道跑的是**同一个提取器** `$SKILL/assets/probe.js`，产出的 JSON 结构完全一致，
后面的 `analyze.mjs` / `report.mjs` 不关心数据是从哪条通道来的。

选通道只看环境，不影响结论质量 —— 差别只在**能不能滚动、能不能切视口/主题**。

---

## 通道 C · 本机 Chrome 全自动

**要求**：Node ≥ 22（要 global `WebSocket`）+ 本机装了 Chrome / Chromium / Edge。

```bash
node $SKILL/scripts/teardown.mjs <url> [选项]
```

| 选项 | 说明 |
|---|---|
| `--out <file>` | 输出路径，默认 `./teardown-<host>.json` |
| `--viewport <WxH>` | 视口，**可重复传**。默认 `1440x900` |
| `--theme <t>` | `light` / `dark` / `both`。默认 `both`，两轮结果一样时自动去重 |
| `--wait <ms>` | load 之后额外等多久，默认 1500 |
| `--no-scroll` | 不滚动。快，但会漏掉懒加载的内容 |
| `--keep-open` | 采完不关浏览器 |

```bash
# 常规
node $SKILL/scripts/teardown.mjs linear.app

# 移动端 + 桌面，只要深色
node $SKILL/scripts/teardown.mjs stripe.com --viewport 390x844 --viewport 1440x900 --theme dark

# 重动画的站，多等一会儿
node $SKILL/scripts/teardown.mjs vercel.com --wait 4000
```

**它比另外两条强在哪**：会先把整页滚一遍再采。懒加载的图、
`IntersectionObserver` 挂着的进场动画、下半页才挂载的组件 —— 不滚就全采不到。
Linear 首页滚过之后能多采到约 40% 的元素。

**常见故障**

| 现象 | 原因 / 处理 |
|---|---|
| `这条通道需要 Node ≥ 22` | 升级 Node，或改走通道 A |
| `找不到 Chrome` | `export CHROME_PATH=<可执行文件路径>` |
| `Chrome 退出了` | 多半是沙箱环境。加 `--no-sandbox` 到脚本的 args 里，或走通道 A |
| `提取器没有返回数据` | 页面 CSP 拦了 eval。走通道 A（控制台不受 CSP 的 eval 限制影响） |
| 采到的元素数远小于预期 | 站点要登录，或有反爬跳转。先手动访问确认，再走通道 A |

---

## 通道 B · agent 自带的浏览器工具

如果当前 agent 有浏览器/CDP 类工具，直接把 probe 交给它的「执行 JS」能力。

**步骤**

1. 用 agent 的导航工具打开目标页
2. 滚到底再回顶（触发懒加载），比如执行：
   ```js
   (async()=>{const s=innerHeight*0.8;for(let y=0;y<document.body.scrollHeight;y+=s){scrollTo(0,y);await new Promise(r=>setTimeout(r,220))}scrollTo(0,0);await new Promise(r=>setTimeout(r,400))})()
   ```
3. 读 `$SKILL/assets/probe.js` 的内容，拼上调用后执行：
   ```js
   <probe.js 全文>; JSON.stringify(window.__TEARDOWN__())
   ```
4. 把返回的字符串按下面的信封格式存成 JSON 文件，再喂给 `analyze.mjs`

**信封格式**（`analyze.mjs` 只认这个结构）：

```json
{
  "tool": "web-teardown",
  "version": 1,
  "target": "https://example.com",
  "capturedAt": "2026-08-26T00:00:00.000Z",
  "channel": "agent-browser",
  "passes": [ <probe 返回的对象> ]
}
```

**各家工具名对照**（有哪个用哪个，名字可能随版本变）：

| Agent / 环境 | 执行 JS 的工具 |
|---|---|
| Claude Code（内置浏览器窗格） | `javascript_tool`，配 `navigate` / `preview_start` |
| Claude in Chrome 扩展 | `javascript_tool` |
| Chrome DevTools MCP | `evaluate_script` |
| Playwright MCP | `browser_evaluate` |
| Puppeteer MCP | `puppeteer_evaluate` |
| 自己写脚本 | `page.evaluate()` |

**注意**：有些 agent 的 JS 执行工具对返回值长度有上限。probe 返回的 JSON 可能到几十 KB，
被截断的话在调用里收窄范围，比如 `JSON.stringify(window.__TEARDOWN__({topN:20}))`。

---

## 通道 A · 浏览器控制台手工粘贴

**零依赖，任何环境都能用**，而且是**登录态页面唯一可行的办法** ——
用户自己的浏览器里本来就是登录好的。

给用户这段话，让他自己操作：

> 1. 在目标页面按 F12（Mac 是 ⌥⌘I）打开控制台
> 2. 先滚到页面底部再滚回顶部（让懒加载的内容都出来）
> 3. 把 `$SKILL/assets/probe.js` 的全部内容贴进控制台，回车
> 4. 再执行这一行，结果会复制到剪贴板：
>    ```js
>    copy(JSON.stringify(__TEARDOWN__()))
>    ```
> 5. 粘回来给我

拿到后同样套上面的信封格式存成 JSON。`channel` 填 `"console"`。

**局限**：只能采当前这一屏配置（视口、主题都是用户浏览器的实际状态），
没法切视口对比。报告里要如实标注。

如果浏览器提示 `Allow pasting`，让用户按提示输入 `allow pasting` 后再贴 —— 这是 Chrome 的防诈骗保护。

---

## 采多个页面

一个站的首页和内页设计系统可能差很多（首页常常是营销页，用的是另一套）。
要全貌就分别采、分别出报告，别把不同页面的数据合并到一个 `passes` 里 ——
`analyze.mjs` 只拿 `passes[0]` 做主分析，混进去只会让结论失真。

```bash
for p in "" /pricing /docs; do
  node $SKILL/scripts/teardown.mjs "stripe.com$p" --out "td$(echo $p | tr / -).json"
done
```
