# web-teardown

**把一个网站的设计系统量出来。** 不截图、不用视觉模型 —— 直接读 CSSOM，
把颜色、字号、字距、圆角、缓动、层级一个一个数出来。

**不绑定任何特定 agent。** 任何能读文件、能跑 JS 的 coding agent
（Claude Code、Codex、OpenCode、Cursor、Cline、Gemini CLI、Continue、Aider…）
配任何能写代码的模型（DeepSeek、Claude、Kimi、GPT、Qwen…）都能用。
提取器是一段纯 JS，**连 agent 都不需要也能跑** —— 贴进浏览器控制台就出数据。

## 解决什么问题

想抄一个站的设计，常规做法是截图 + 取色插件 + 肉眼猜。
问题是：取色插件只给你颜色，给不了字距、行高、缓动曲线、层级规划；
而肉眼永远看不出「这个站的中性色其实全部带了 0.01 的彩度」。

这个 skill 换了条路：**页面自己就带着答案**。CSS 变量、computed style
里躺着完整的数值，遍历一遍就能拿到 —— 比任何视觉推断都准，而且**不需要模型有眼睛**。

## 最值钱的一节：漂移检测

配色和字体谁都能抓，抓完是一张频次表，没意思。
真正只有全量测量才撞得见的是这个 —— **token 里写的和页面上实际跑的对不上**：

> 拿 linear.app 实测的结果（2026-08-27，1440x900）：
>
> - 速度 token 定义了 4 档，用得最多的 `0.42s`（出现 438 次）**根本不在表里**
> - 定义了 18 条缓动曲线，实测只有 1 条真在用，其余 17 条是死库存
> - 19 个中性色全部带彩度、色相聚在 240° 附近，唯独 `#3b3b3b` 彩度是 0 —— 漏网的那一个
> - 36 个高频色里有 14 个（39%）追不到任何 CSS 变量
>
> 这些数字会随人家发版而变 —— 引用前自己重跑一次。

人眼读 CSS 读不出这些。这也是为什么这类内容能立住：
**它不是吹捧稿，它敢说 Linear 哪里没对齐。**

## 装

```bash
git clone --depth 1 https://github.com/whyubel1eve/web-teardown-skill.git web-teardown
cd web-teardown
./install.sh                      # 自动探测常见 agent 的技能目录
./install.sh ~/my-agent/skills    # 或者直接指定
```

懒得自己动手，也可以把这段直接发给你的 agent：

```text
帮我装 web-teardown skill：
git clone --depth 1 https://github.com/whyubel1eve/web-teardown-skill.git <你的技能目录>/web-teardown
（Claude Code 是 ~/.claude/skills/web-teardown；别的 agent 放你自己的 skills / rules 目录）
然后读一遍 web-teardown/SKILL.md，那是入口。
```

脚本会依次探测 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`、
`~/.opencode/skills`、`~/.cursor/skills`、`~/.gemini/skills`、`~/.cline/skills`
以及当前项目下的 `.claude/skills` / `.agents/skills`，
探测不到就装到当前目录。**装到哪都行，只要你的 agent 能读到那个目录里的文件。**

装完让 agent 读 `SKILL.md`，它自己知道该怎么走。

### 依赖全是可选的

| 有什么 | 能做什么 |
|---|---|
| Node ≥ 22 + Chrome | 全自动：滚动触发懒加载、多视口、明暗双主题 |
| 只有 Node | 分析和渲染可用，采集走 agent 的浏览器工具或控制台 |
| **什么都没有** | 照样能用 —— 提取器贴进浏览器控制台，把 JSON 交给 agent 分析 |

## 用

对 agent 说人话就行：

```
扒一下 linear.app 的设计系统
这个站的配色和字号阶梯是什么？ https://…
帮我把 stripe.com 的 design token 提出来
```

想自己跑：

```bash
node scripts/teardown.mjs linear.app --out td.json      # 采集
node scripts/analyze.mjs td.json     --out an.json      # 分析
node scripts/report.mjs  an.json     --out report.html  # 出解剖图
```

多视口 / 多主题：

```bash
node scripts/teardown.mjs stripe.com --viewport 390x844 --viewport 1440x900 --theme both
```

## 三条采集通道

同一个提取器（`assets/probe.js`），产出结构完全一致，选能跑的那条。

| 通道 | 要求 | 能力 |
|---|---|---|
| **C · 本机 Chrome** | Node ≥22 + Chrome | 最全：滚动、多视口、多主题 |
| **B · agent 自带浏览器** | agent 有浏览器/CDP 工具 | 够用，滚动要自己发指令 |
| **A · 控制台粘贴** | 一个浏览器 | 零依赖；**登录态页面唯一可行的办法** |

通道 B 支持 Claude Code 浏览器窗格、Chrome DevTools MCP、Playwright MCP、
Puppeteer MCP 等等，工具名对照见 `references/channels.md`。

## 它会告诉你什么

- **置信度 A/B/C** —— 这个站暴不暴露语义 token，决定了报告能说到什么程度。
  C 级站照样能做，但报告性质从「解剖设计系统」变成「统计页面用了什么」，**开头就会写明**
- **OKLCH 色板 + token 溯源** —— 每个色标带明度/彩度/色相和它的变量名，追不到的标红
- **复合文字样式阶梯** —— 字号/行高/字距/字重绑在一起的真实样式，不是四张独立频次表
- **字距曲线** —— 按 token 族分开画。规整的台阶说明有人设计过，抖成锯齿说明是各处随手写的
- **缓动库存** —— 定义了几条、实际用了几条，画成曲线阵列一目了然
- **z-index 层级梯 / 间距网格 / 圆角 / 阴影 / 交互态词汇**

## 边界

- **纯 canvas / WebGL 页面**没有 CSSOM，采不到 —— 动手前先看一眼
- **跨域样式表**读不出 `cssRules`，交互态（hover/focus）会缺，报告里会标注
- **登录页**：通道 C 是干净 profile 登不进去，走通道 A（用户自己的浏览器本来就登录着）
- 一次采一个页面。首页常常是营销页，和内页不是一套系统 —— 要全貌就分别采
- 采到的是**这一刻这一屏配置**的结果。只采了一个视口就别下"响应式做得好"的结论

## 自检

```bash
node scripts/selftest.mjs
```

不联网、不开浏览器，用一份**故意埋了每一种漂移**的数据把管线跑一遍。
它同时是检测器的回归测试 —— 哪条检测失灵了，这里就会红。

## 协议

MIT
