# image-context-cascade

[English](README.md) | 简体中文

**面向 AI coding agent 的请求级图片生命周期中间件：保留当前轮图片，把历史图片降级为稳定占位符——在它们撑爆你的 token 账单、prompt cache 和 413 之前。**

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

- **当前轮图片原样保留。** 模型能看到你刚刚贴上的东西。
- **历史图片变成稳定的文本占位符。** 跨请求字节级一致，prompt cache 持续命中。
- **一切皆可度量。** Telemetry 报告数量与预估节省——且永远不包含图片数据。

真实 1.3 MB PNG payload 实测：**1,296,014 字符 → 315 字符（−99.98%）**。活体 session 中，降级四张历史图片后每请求节省约 417 万字符；input tokens 从 91,734 降至 1,910，cache 读取从 11,776 恢复到 100,352。

## 它不是什么

- **不是 prompt 技巧。** Prompt 删不掉请求 payload 里的字节；这是中间件。
- **不是通用上下文压缩。** 它只管理图片，不碰你的文本历史。
- **不是对所有 agent 自动生效。** 你的 agent 需要一个请求构造钩子。写一个 adapter 约 40–60 行（见 [Pi 参考 adapter](packages/adapters/pi/src/index.ts)）；conformance 套件会告诉你写对了没有。
- **（暂时）不是图片找回工具。** 占位符会引导模型在真正需要原图时请用户重新提供。见[路线图](#路线图)。

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

对没有请求构造钩子的 agent——包括 Claude Code——CLI 可以离线重写膨胀的 session 文件：

```bash
npx image-context-cascade-cli rescue path/to/session.jsonl        # dry-run：展示能省多少
npx image-context-cascade-cli rescue path/to/session.jsonl --yes  # 先备份原文件，再重写
```

两遍流式扫描、O(1) 内存、自动备份、原子写入、坏行原样透传、幂等。真实 381 行 Claude Code session 实测：**6.26 MB → 1.36 MB（−78%）**，35 个历史附件被降级，每一行仍是合法 JSON，当前轮内容一字未动。

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

1. **发现** —— 遍历 payload，按 provider 格式匹配图片块（Anthropic base64 块、OpenAI Chat `image_url`、OpenAI Responses `input_image`、data URI），外加 Anthropic 的 base64 `document` 附件（如 PDF）——它们造成的历史重发问题一模一样。
2. **分类** —— 每个图片块经可插拔策略判定为 `current`、`historical` 或 `unknown`。
3. **替换** —— 历史图片变成携带 12 位内容 hash 的确定性占位符。同一张图、同样的字节、每次请求——这就是 prompt cache 保持命中的原因。
4. **报告** —— telemetry 输出计数、分格式统计与预估节省。永远没有 base64。

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

要支持新的 provider 格式？实现一个 `BlockMatcher`（`match(block)` / `replace(block, text)`），通过 `formats` 传入即可。**不要**自己重新实现分类、占位符或遍历——行为漂移就是这么来的。跑一遍 conformance 套件（`image-context-cascade-conformance`），验证你的 adapter 保留当前轮图片、降级历史图片、占位符字节稳定、telemetry 零泄漏。

## 隐私与安全保证

- **图片数据不会离开它原本所在的进程边界。** 本库只会从 payload 里*移除*图片字节；添加的只有简短的文本占位符。
- **Telemetry 无法携带图片数据。** `CascadeTelemetry` 类型不存在能装 base64 的字段；conformance 测试还会序列化 telemetry 并断言其中不含图片数据模式。
- **进入上下文的只有 12 位单向 hash 前缀。** 没有文件名、没有路径、没有像素数据。
- **当前轮图片绝不触碰。** 由测试锁定（`current_turn_images_never_touched`）；positional 策略在无法确立边界时 fail-open。

## 局限

- 如果你的工作流需要模型跨多轮反复检视原始像素（例如像素级视觉对比），降级历史图片会带来负面影响——请保持这类 session 简短，或使用自定义策略保留图片，直到 v0.2 的生命周期策略落地。
- 模型无法自行"再看一眼"已降级的图片；占位符会引导它请用户重新提供。自动重查需要后续版本规划中的 source store。
- 没有请求构造钩子的封闭 agent（如今天的 Claude Code）无法在进程内运行本中间件；请改用 [rescue CLI](#抢救超大-session-cli) 离线重写 session 文件。
- 仅支持精确去重：同一张图片重新编码或缩放后 hash 不同（感知哈希属于未来研究方向）。

## 路线图

- **v0.1（本版本）**—— core 与 positional + tracker 双策略、三种 provider 图片格式加 Anthropic document 附件的内置 matcher、session 抢救 CLI、Pi 参考 adapter、含语言无关语料的 conformance 套件、经验证的基准测试。
- **v0.2** —— 请求代理集成（基于 positional 策略的零适配路径）；生命周期策略（`retain` / `ephemeral` / `summarize` / `drop`）；图片摘要存储（占位符内联携带简短描述）；OpenAI / Anthropic 官方 SDK 中间件 adapter。
- **未来研究** —— 近似图片的感知哈希；source store 与按需重查工具；带安全隐私默认值的跨会话持久 tracker。

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
