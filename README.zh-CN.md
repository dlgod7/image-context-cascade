# image-context-cascade

[English](README.md) | 简体中文

**面向 AI coding agent 的请求级图片生命周期中间件：当前轮原图保持 hot，近期历史可降为 warm 缩略图，远期历史变成 cold 可找回占位符——在它们撑爆你的 token 账单、prompt cache 和 413 之前。**

零运行时依赖。框架无关的 core。支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种 payload 形态。

---

## 问题

**你的 agent 正在反复发送模型早就看过的像素。**

在一个真实的 UI 开发 session 中，截图占掉了**上下文窗口的 86.3%**——6,988 KB 的 base64，对比之下 assistant 的实际回复只有 235 KB（[claude-code#24298]）。Codex 用户观测到 **8.34 MB 的请求体**和约 570 万 prompt tokens，其中单条历史工具消息携带了一个 768 万字符的 PNG data URL（[codex#28316]）。粘贴的截图曾直接搞挂 `/compact` 本身，session 无法恢复、只能手动删除 session 文件（[claude-code#16649]）；超大图片 payload 还会触发 413 并永久损坏 session（[claude-code#9269]）。

图片是一次性输入。模型看过截图、做出响应之后，那些像素就成了死重——但多数 agent 会把它们塞进之后的每一次请求里：烧 token、扰乱 prompt cache，最终撞上请求体积上限。

Compaction 救不了这个问题，原因是结构性的：**413 在请求离开进程的那一刻就发生了——任何 compaction 都来不及运行，而且图片本身就能把 compaction 搞挂**（[claude-code#16649]）。唯一能彻底解决问题的层，是请求构造层。

`image-context-cascade` 就在这一层解决它。

## 它做什么

在每一次 provider 请求上：

- **Hot：当前轮图片原样保留。** 模型能看到你刚刚贴上的东西。
- **Warm：近期历史图片可变成缩略图。** 宿主注入确定性的 `thumbnailer`；core 不内置任何图像处理依赖。
- **Cold：更老的图片变成稳定、可找回的占位符。** 开启 source store 后，占位符里的 hash 也是找回主键；不开 store 时默认占位符与 v0.1 字节兼容。
- **一切皆可度量。** Telemetry 报告数量、tier、去重、store 错误与预估节省——且永远不包含图片数据。

真实 1.3 MB PNG payload 实测：**1,296,014 字符 → 315 字符（−99.98%）**。活体 session 中，降级四张历史图片后每请求节省约 417 万字符；input tokens 从 91,734 降至 1,910，cache 读取从 11,776 恢复到 100,352。

## 它不是什么

- **不是 prompt 技巧。** Prompt 删不掉请求 payload 里的字节；这是中间件。
- **不是通用上下文压缩。** 它只管理图片，不碰你的文本历史。
- **不是对所有 agent 自动生效。** 你的 agent 需要一个请求构造钩子。写一个 adapter 约 40–60 行（见 [Pi 参考 adapter](packages/adapters/pi/src/index.ts)）；conformance 套件会告诉你写对了没有。

## 快速开始

```bash
npm install image-context-cascade
```

```ts
import { cascadeImages } from "image-context-cascade";

// 在你的 agent 构造 provider 请求的地方：
const { payload, mutated, telemetry } = cascadeImages(requestPayload);

// payload：历史图片已替换为稳定占位符，当前轮图片原样保留
// telemetry：{ found, current, downgraded, estimatedSavedChars, ... }
//            —— 只有计数和 hash，永远没有图片数据
```

这就是默认的 **positional 策略**：最后一条 user 消息及其后的图片是当前轮，更早的一律降级。它是无状态的——重启无损，对每次只看到单个请求的代理也同样正确。

## 抢救超大 session（CLI）

对没有请求构造钩子的 agent——包括 Claude Code 和 Codex——CLI 可以离线重写膨胀的 session 文件：

```bash
npx @image-cascade/cli rescue path/to/session.jsonl                 # dry-run：展示能省多少
npx @image-cascade/cli rescue path/to/session.jsonl --yes           # 先备份原文件，再重写
npx @image-cascade/cli rescue path/to/session.jsonl --yes --store   # 同时把被降级的原图存到本地

# 之后：用占位符 hash 找回。
npx @image-cascade/cli restore a1b2c3d4e5f6 --out restored.png
```

也可以 `npm install -g @image-cascade/cli` 全局安装——装出来的命令名是 `image-cascade`。

两遍流式扫描、O(1) 内存、自动备份、原子写入、坏行原样透传、幂等。`--store` 是显式 opt-in，默认把 source store 写到 `~/.image-cascade/store`，也可以传目录。

session 文件的位置：

- **Claude Code**：`~/.claude/projects/<项目>/*.jsonl` —— 真实 381 行 session 实测：**6.26 MB → 1.36 MB（−78%）**，35 个历史附件被降级，每一行仍是合法 JSON。
- **Codex**：`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` —— 真实 332 行 rollout 实测：**50.2 MB → 2.26 MB（−95.5%）**。Codex 会把每张生成图以裸 base64 存*两份*（`image_generation_call` 响应项 + `image_generation_end` 事件），所以图片密集的 Codex session 缩得尤其狠。

**不要重写正在打开的 session。** agent 进程可能还在往文件里追加内容。先关掉会话，或者对拷贝件操作。agent 运行期间抢救*其他* session 没有问题。

## 丢给你的 agent 一键搞定（复制即用）

不想读文档的话，把下面这段直接粘给 Claude Code、Codex 或任何有 shell 的 coding agent，它会替你搞定：

```text
安装 image-cascade CLI 并压缩我过大的 AI agent session 文件。严格按以下步骤执行：

1. 运行：npm install -g @image-cascade/cli
   验收：`image-cascade --version` 打印出版本号。如果不允许全局安装，下面所有 image-cascade 命令改用 `npx @image-cascade/cli`。
2. 按体积列出我最大的 5 个 session 文件：
   - Claude Code：~/.claude/projects/*/*.jsonl（Windows 在 %USERPROFILE%\.claude\projects\）
   - Codex：~/.codex/sessions/*/*/*/rollout-*.jsonl（Windows 在 %USERPROFILE%\.codex\sessions\）
3. 安全规则：绝不碰你当前这个会话自己的 session 文件。列表里如果有可能还开着的会话，先让我关掉，或者跳过它。
4. 对每个候选文件先 dry-run：image-cascade rescue <文件>
   这一步不写任何东西。记下它打印的 estimatedSavedChars 和 estimatedBytesAfter。
5. 只对 dry-run 显示节省有意义（大于约 100 KB）的文件执行：
   image-cascade rescue <文件> --yes --store
   写入前会在原文件旁生成备份（.icc-backup）；--store 让每张被移除的图都能用 `image-cascade restore <hash>` 找回。
6. 汇报一张表：文件、前后字节数、降级图片数、备份路径。不要删备份。
```

当前轮图片永远不被触碰，重写是原子且幂等的，每张被移除的图都能从备份找回——开了 `--store` 还能从本地 store 按 hash 找回。

## 把降级的图找回来

使用 `rescue --yes --store` 后，cold 占位符里的短 hash 可以用于恢复原始字节。Claude Code 不需要 MCP server：只要 agent 有 shell 工具和文件/图片读取工具，就能把图片恢复成普通文件，再把它作为当前轮内容读取。

示例流程：

```text
用户：请再看一下 Image a1b2c3d4e5f6。
助手 shell：image-cascade restore a1b2c3d4e5f6 --out restored-a1b2c3d4e5f6.png
助手：用宿主的文件/图片工具读取 restored-a1b2c3d4e5f6.png，再基于这个当前轮内容回答。
```

Restore 是追加新的当前内容，不是回填历史消息；因此不会破坏已有 prompt-cache 前缀。

## 工作原理

```
                      ┌────────────────────────────────────────────┐
 agent 主循环         │  provider 请求 payload                     │
 ───────────►  构造   │  [ msg1(图A) msg2 msg3(图B) msg4(图C) ]    │──► cascade ──► 发出
                      └────────────────────────────────────────────┘        │
                                                                            ▼
                                              图 A、B → [Image a1b2c3d4e5f6 omitted …]
                                              图 C（当前轮）→ 原样发送
```

1. **发现** —— 遍历 payload，按 provider 格式匹配图片块（Anthropic base64 块、OpenAI Chat `image_url`、OpenAI Responses `input_image`、data URI、`image_generation_call` 的裸 base64 result），外加 Anthropic 的 base64 `document` 附件（如 PDF）——它们造成的历史重发问题一模一样。图片块在哪都认得：content 数组里、消息列表的 item 级条目、或 transcript 行的对象字段。
2. **分类** —— 每个图片块经可插拔策略判定为 `current`、`historical` 或 `unknown`。
3. **分层** —— 当前轮保持 hot；历史图片按 tier policy 与 thumbnailer 变成 warm 缩略图或 cold 占位符。
4. **存储与找回** —— 开启 source store 时，原始字节按内容 hash 存到本地，之后可用 `image-cascade restore <hash>` 找回。
5. **报告** —— telemetry 输出计数、分格式统计、tier、去重、store 错误与预估节省。永远没有 base64。

## 策略

### `positionalStrategy()` —— 默认策略

按位置分类：消息数组中最后一条 user 消息及其后的图片是当前轮，更早的是历史。

**为什么安全：** 任何位于更早消息里的图片，必然在它还是"当前轮"的那次请求中被完整发送过——模型已经看过它。不需要任何跨请求状态，所以重启零损失、无状态代理也能正确工作。找不到 user 消息边界时，它 fail-open：全部保留。

### `trackerStrategy({ currentTurnHashes, tracker })`

给能精确知道"哪些图片属于当前轮"的宿主（例如有轮次开始钩子的 agent 框架）：

```ts
import { cascadeImages, trackerStrategy, InMemoryTracker } from "image-context-cascade";

const tracker = new InMemoryTracker();          // LRU，200 条
// 轮次开始时：把新附加图片的 hash 收进 currentTurnHashes

const result = cascadeImages(payload, {
  strategy: trackerStrategy({ currentTurnHashes, tracker }),
});
```

Tracker 模式多一层安全细化：既不是当前轮、也没被追踪过的图片是 **unknown**，会原样放行一次，之后才可降级。适用于 transcript 可能被外部改写、或需要按图片粒度做生命周期控制的场景。

## 编写 adapter

Adapter 是宿主钩子与 core 之间的胶水——[Pi 参考 adapter](packages/adapters/pi/src/index.ts) 只有 57 行：

1. 在请求构造处调用 `cascadeImages(payload, options)`，转发（可能被改写的）payload。
2. 可选：在轮次开始时记录当前轮图片 hash，改用 `trackerStrategy`。
3. 把 `telemetry` 发到宿主的日志——它在类型构造上就是安全的（不存在能装图片数据的字段）。

要支持新的 provider 格式？实现一个 `BlockMatcher`（`match(block)` / `replace(block, text)`），通过 `formats` 传入即可。**不要**自己重新实现分类、占位符或遍历——行为漂移就是这么来的。跑一遍 conformance 套件（`@image-cascade/conformance`），验证你的 adapter 保留当前轮图片、降级历史图片、占位符字节稳定、telemetry 零泄漏。

## 隐私与安全保证

- **图片数据不会离开它原本所在的进程边界。** 本库只会从 payload 里*移除*图片字节；添加的只有简短的文本占位符。
- **Telemetry 无法携带图片数据。** `CascadeTelemetry` 类型不存在能装 base64 的字段；conformance 测试还会序列化 telemetry 并断言其中不含图片数据模式。
- **进入上下文的只有 12 位单向 hash 前缀。** 没有文件名、没有路径、没有像素数据。
- **当前轮图片绝不触碰。** 由测试锁定（`current_turn_images_never_touched`）；positional 策略在无法确立边界时 fail-open。

## 局限

- 远程 URL 引用图不会进入 store。Source store 只保存 payload 中已经存在的 base64/data URI 字节，不主动抓取 URL。
- 仅支持精确字节身份：同一张图片重新编码或缩放后 hash 不同；感知哈希属于未来研究方向。
- Warm 缩略图需要宿主注入确定性的 `thumbnailer`。Core 和 CLI 都不依赖 Sharp 或其他图像处理库。
- 没有请求构造钩子的封闭 agent（如今天的 Claude Code 和 Codex）无法在进程内运行本中间件；请改用 [rescue CLI](#抢救超大-session-cli) 离线重写 session 文件。

## 路线图

- **v0.1**—— core 与 positional + tracker 双策略、三种 provider 图片格式加 Anthropic document 附件的内置 matcher、session 抢救 CLI、Pi 参考 adapter、含语言无关语料的 conformance 套件、经验证的基准测试。
- **v0.2**—— opt-in source store、hot/warm/cold 三层降级模型、注入式 thumbnailer 接口、可找回占位符、`image-cascade restore`、同 payload 精确字节去重，以及 Claude Code 通过 shell + 文件工具完成的零组件找回闭环。
- **v0.2.1（本版本）**—— Codex rollout session 端到端实测通过；新增 `image_generation_call` / `image_generation_end` 裸 base64 result 的 matcher；遍历引擎现在也匹配消息列表的 item 级块和对象字段块，不再只认 content 数组成员。
- **v0.3 计划**—— 预算驱动降级、更丰富的宿主 adapter，以及面向没有 shell 工具的宿主的 optional MCP server。
- **未来研究** —— 近似图片的感知哈希；带安全隐私默认值的跨会话持久 tracker。

## 先行工作与致谢

Claude Code 与 Codex 社区各自独立地表述了这个问题，并勾勒了相似的解法——image-aware compaction、ephemeral image 标记、`/drop-images`、sha256 占位符（[claude-code#24298]、[codex#28316]）。本项目的存在，就是为了把这些草图变成一个正确、可安装、框架无关的实现。**如果 coding agent 们原生内置了图片生命周期管理，本项目的使命就完成了。**

解决*不同*问题的相关项目：

- [pi-vision-proxy](https://github.com/pungggi/pi-vision-proxy) 与 [opencode-vision-paste](https://github.com/wsaaaqqq/opencode-vision-paste) 把图片路由给视觉模型，让*纯文本*模型也能用图。它们让图片可读；`image-context-cascade` 管理的是*多模态*模型已经读过的图片的生命周期。两者互补。
- [context-cascade](https://github.com/DNYoussef/context-cascade) 是 Claude Code 的分层上下文加载插件架构——除名字相近外并无关联。

## 协议

[Apache-2.0](LICENSE)。欢迎贡献——支持新 agent 或新 provider 格式的最快路径，见 adapter 指南与 conformance 套件。

[claude-code#9269]: https://github.com/anthropics/claude-code/issues/9269
[claude-code#16649]: https://github.com/anthropics/claude-code/issues/16649
[claude-code#24298]: https://github.com/anthropics/claude-code/issues/24298
[codex#28316]: https://github.com/openai/codex/issues/28316
