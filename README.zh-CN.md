# image-context-cascade

[English](README.md) | 简体中文

**你的 agent 每一轮都在重发你早就贴过的截图。** 模型第一轮就看过的图，后面几十轮还在为它反复付钱——token 烧掉、缓存打乱、最惨直接 413，整个 session 报废。

`image-context-cascade` 在请求离开你的进程之前，把历史图片降级为可找回的轻量占位符，当前轮图片原样保留。降级历史会改变缓存前缀，但占位符是稳定文本，重建后不再漂移——实测缓存命中不受明显损害。**一条命令把 50 MB 的 session 压回 2 MB，删掉的图随时能找回来。**

零运行时依赖 · 框架无关 · 支持 Anthropic / OpenAI Chat / OpenAI Responses 三种 payload

---

## 它解决什么问题

用 Codex、Claude Code 这类 agent 贴图做 UI 开发时，每张截图都以 base64 躺在 session 里，**每一轮请求都原样重发**。一个真实 session 里，截图吃掉了 86.3% 的上下文窗口；Codex 那边更狠，单个请求体 8.34 MB、五百多万 prompt token。session 越来越重，`/compact` 压不动，超大 payload 直接 413 把 session 搞死。

Compaction 救不了——413 在请求离开进程的那一刻就发生了，任何 compaction 都来不及运行，而且图片本身就能把 compaction 搞挂。唯一能彻底解决的层，是请求构造层。本项目就在这一层干活。

Claude Code 和 Codex 社区都已意识到这个问题，官方 issue 里有大量讨论和相似方案的草图。但改动牵扯请求构造、缓存策略、会话恢复等多个环节，官方短期难以落地。本项目把社区草图变成可用实现，在原生方案出来之前先顶上。

## 核心特点

**三层图片生命周期，自动分级：**

| 层级 | 对象 | 处理方式 |
|---|---|---|
| **Hot** | 当前轮图片 | 原样保留，模型看到你刚贴的 |
| **Warm** | 近期历史图片 | 可降为缩略图（宿主注入 thumbnailer） |
| **Cold** | 更老的历史图片 | 变成稳定占位符，需要时按 hash 找回原图 |

**设计保证（所有模式共守）：**

- **缓存影响可控** — 降级历史必然改变缓存前缀，但占位符是稳定文本，重建后不再漂移，实测命中不受明显损害
- **归档不删除** — 每张被降级的图都能按 hash 找回，不存在不可恢复的丢失
- **不碰文本历史** — 只管理图片，你的对话内容一字不动
- **无常驻占用** — 没有守护进程，hook 只在会话边界跑几毫秒，没东西可归档时幂等空转
- **不做内容判断** — 分类是位置化、确定性的，没有模型替你决定哪张图"重要"
- **隐私安全** — 图片数据不离开原有进程边界，telemetry 只有计数和 hash，永远不含图片数据

**实测效果：** 真实 1.3 MB PNG → 315 字符（−99.98%）；活体 session 降级四张历史图后，input tokens 从 91,734 降至 1,910，cache 读取从 11,776 恢复到 100,352。

## 客观局限

本项目有用，但不是万能的，以下是你需要知道的：

- **只管图片，不碰文本。** 它不是通用上下文压缩。
- **适配程度因 agent 而异。** 最兼容的是 Pi 等开源、可自由改请求构造的 agent（全自动）；Claude Code 用 SessionEnd hook 做会话边界自动归档；Codex 目前只能半自动（agent 提议、你批准）；其他没有钩子的 agent 只能手动跑 CLI。
- **中间件性质决定有安装失败可能。** 不同机器、不同 agent 配置甚至改装都可能导致问题——虽然不大，但不排除特例。好在 AI 大多可以修理甚至本土化。
- **远程 URL 图片不进 store。** 只处理 payload 里已有的 base64/data URI，不主动抓取 URL。
- **仅精确字节身份匹配。** 同一张图重新编码或缩放后 hash 不同，感知哈希属于未来研究。
- **老 session 的 resume 属于 best-effort。** Rescue 保证文件精简、合法、可找回，但不保证宿主一定能 resume（实测 Codex 有时以无关校验拒绝）。

## 快速开始

### 方式一：丢一句话给你的 agent（推荐）

不管你用哪个 coding agent，把这段贴给它，它会自己读取安装指南、识别所在宿主、完成配置：

```text
Read and follow https://raw.githubusercontent.com/dlgod7/image-context-cascade/main/docs/setup/README.md
— identify which agent host YOU are running in, then apply the guide for YOUR host
(Pi / Claude Code / Codex / generic). This is configuration only: do NOT read, list,
or rewrite any session/transcript files. When done, report what you changed and how to undo it.
```

想自己看的话：[Pi](docs/setup/pi.md) · [Claude Code](docs/setup/claude-code.md) · [Codex](docs/setup/codex.md) · [其他宿主](docs/setup/generic.md)

### 方式二：CLI 手动抢救已有 session

```bash
npm install -g @image-cascade/cli

image-cascade rescue session.jsonl                 # dry-run：先看看能省多少
image-cascade rescue session.jsonl --yes --store   # 备份原文件 + 重写 + 归档原图
image-cascade restore a1b2c3d4e5f6 --out img.png   # 随时找回任意一张被降级的图
```

### 各 agent 日常效果一览

| 宿主 | 机制 | 你得到什么 |
|---|---|---|
| **Pi** | 自带 adapter → `before_provider_request` | **全自动，每次请求实时生效**，历史图归档可找回——参考级集成 |
| 自维护 agent / 框架 | 请求构造处调 `cascadeImages()` | 全自动，每次请求实时生效 |
| Claude Code | `SessionEnd` hook → `image-cascade hook claude-code` | 每次会话结束自动归档；resume 加载瘦身后的 transcript |
| Codex | `AGENTS.md` 软指令 + 手动 `rescue` | 半自动——agent 提议，你批准 |
| 其他任意 agent | `npx @image-cascade/cli rescue` | 手动，任何 JSON/JSONL transcript 都能用 |

**实测案例：**
- Claude Code 381 行 session：**6.26 MB → 1.36 MB（−78%）**，35 个历史附件降级
- Codex 332 行 rollout：**50.2 MB → 2.26 MB（−95.5%）**（Codex 把每张生成图存两份，缩得尤其狠）

> ⚠️ **不要重写正在打开的 session。** agent 进程可能还在追加内容。先关掉会话或对拷贝件操作。抢救*其他* session 没问题。

## 把降级的图找回来

用 `rescue --yes --store` 后，占位符里的短 hash 就是找回主键。不需要 MCP server——只要 agent 有 shell 工具和文件读取工具：

```text
用户：请再看一下 Image a1b2c3d4e5f6。
助手：image-cascade restore a1b2c3d4e5f6 --out restored.png
      （读取 restored.png，作为当前轮内容回答）
```

Restore 是追加新内容，不回填历史，所以不破坏 prompt-cache 前缀。

## 体验对比（可选）

想先看看能在你已有 session 上省多少？把这段贴给 agent，它会列出最大的 session 文件、dry-run 给你看数字，你批准哪个才改哪个（全程有备份）：

```text
给我看看 image-context-cascade 在我已有的 agent session 上能省多少。
先说明：这个任务会列出我的 session 文件，并在我批准后重写其中一部分（有备份）。

1. 确认 CLI 可用（image-cascade --version，或改用 npx @image-cascade/cli）。
2. 找到我这个宿主的 session 目录（Claude Code：~/.claude/projects/*/*.jsonl；
   Codex：~/.codex/sessions/*/*/*/rollout-*.jsonl；其他宿主：自己定位 transcript
   目录——Windows 下在 %USERPROFILE% 里）。按体积列出最大的 5 个。
3. 安全规则：绝不碰当前这个对话自己的 session 文件；可能在别的窗口开着的
   session 一律跳过（拿不准就问我）。
4. 逐个 dry-run：image-cascade rescue <文件>   （不写任何东西；记下数字）
5. 把 dry-run 结果表给我看，问我批准哪些。只对批准的文件执行：
   image-cascade rescue <文件> --yes --store
6. 汇报：文件、前后字节数、归档图片数、备份路径。不要删备份。
```

---

## 深入了解

以下内容给想理解原理或自行集成的开发者。大多数用户到上面"快速开始"就够了。

### 工作原理

```
                      ┌────────────────────────────────────────────┐
 agent 主循环         │  provider 请求 payload                     │
 ───────────►  构造   │  [ msg1(图A) msg2 msg3(图B) msg4(图C) ]    │──► cascade ──► 发出
                      └────────────────────────────────────────────┘        │
                                                                            ▼
                                              图 A、B → [Image a1b2c3d4e5f6 omitted …]
                                              图 C（当前轮）→ 原样发送
```

1. **发现** — 遍历 payload，按 provider 格式匹配图片块（Anthropic base64 块、OpenAI Chat `image_url`、OpenAI Responses `input_image`、data URI、`image_generation_call` 裸 base64），外加 Anthropic base64 `document` 附件（如 PDF）。图片块在哪都认：content 数组、item 级条目、对象字段。
2. **分类** — 每个图片块经策略判定为 `current` / `historical` / `unknown`。
3. **分层** — 当前轮保持 hot；历史图片按 tier policy 与 thumbnailer 变成 warm 或 cold。
4. **存储与找回** — 开启 source store 时，原始字节按内容 hash 存到本地，可用 `restore <hash>` 找回。
5. **报告** — telemetry 输出计数、分格式统计、tier、去重、预估节省。永远没有 base64。

### 默认策略：positional

按位置分类——最后一条 user 消息及其后的图片是当前轮，更早的是历史。**为什么安全：** 更早消息里的图片必然在它还是"当前轮"时被完整发送过，模型已经看过。不需要跨请求状态，重启零损失。找不到边界时 fail-open（全部保留）。

### 使用库（agent / 框架作者）

```bash
npm install image-context-cascade
```

```ts
import { cascadeImages } from "image-context-cascade";

const { payload, mutated, telemetry } = cascadeImages(requestPayload);
// payload：历史图片已替换为稳定占位符，当前轮原样保留
// telemetry：{ found, current, downgraded, estimatedSavedChars, ... }——只有计数和 hash
```

如果你的 agent 能精确知道当前轮图片（如有轮次开始钩子），可用 `trackerStrategy` 做更细粒度控制。详见 [Pi 参考 adapter](packages/adapters/pi/src/index.ts)（99 行，含完整 store/restore 接线）。

### 编写 adapter

要支持新 provider 格式，实现一个 `BlockMatcher`（`match` / `replace`），通过 `formats` 传入。**不要**自己重新实现分类、占位符或遍历——行为漂移就是这么来的。跑一遍 conformance 套件（`@image-cascade/conformance`）验证正确性。

### 隐私与安全

- 图片数据不离开原有进程边界——本库只移除图片字节，只添加短文本占位符
- Telemetry 类型构造上就无法携带图片数据，conformance 测试额外断言
- 进入上下文的只有 12 位单向 hash 前缀，没有文件名、路径、像素数据
- 当前轮图片绝不触碰，由测试锁定

### CLI 完整参考

```bash
image-cascade rescue <file>                    # dry-run
image-cascade rescue <file> --yes              # 备份 + 重写
image-cascade rescue <file> --yes --store      # 同时归档原图
image-cascade restore <hash> --out <file>      # 找回归档图片
image-cascade hook claude-code                 # SessionEnd hook 入口
```

两遍流式扫描、O(1) 内存、自动备份、原子写入、坏行透传、幂等。`--store` 写到 `~/.image-cascade/store`（`ICC_STORE_DIR` 可改位置）。`ICC_DISABLE=1` 关闭一切 hook 自动处理。

## 版本与发布

详细版本历史和源码包见 [GitHub Releases](https://github.com/dlgod7/image-context-cascade/releases)。npm 包：[`image-context-cascade`](https://www.npmjs.com/package/image-context-cascade)（core）· [`@image-cascade/cli`](https://www.npmjs.com/package/@image-cascade/cli)（CLI）。

## 先行工作与致谢

Claude Code 与 Codex 社区各自独立表述了这个问题并勾勒了相似解法——image-aware compaction、ephemeral image 标记、`/drop-images`、sha256 占位符。本项目把这些草图变成了正确、可安装、框架无关的实现。**如果 coding agent 们原生内置了图片生命周期管理，本项目的使命就完成了。**

解决*不同*问题的相关项目：[pi-vision-proxy](https://github.com/pungggi/pi-vision-proxy) 与 [opencode-vision-paste](https://github.com/wsaaaqqq/opencode-vision-paste) 让纯文本模型也能用图（让图片可读）；本项目管理的是多模态模型已读图片的生命周期。两者互补。

感谢 [linux.do](https://linux.do) 社区的反馈与讨论，感谢 Fable-5（Claude Code 下）对项目的贡献。

## 协议

[Apache-2.0](LICENSE)。欢迎贡献——支持新 agent 或新 provider 格式的最快路径，见 adapter 指南与 conformance 套件。
