<div align="center">

# QQ Inori

**一个住在 QQ 里的本地 AI 伙伴。**

会记事、会看场合、有自己的生活——不是"接个大模型就能聊"的壳。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Windows-0078D4.svg)](#要求)

</div>

---

> **这是什么**：一套可自托管的 QQ AI 伙伴部署。QQ 消息经 SnowLuma（OneBot v11）进入
> `qq-bridge`，桥接把它变成 DeepSeek Harness（DSH）agent 会话；agent 的回复、提问和
> 工具审批再回到 QQ。长期记忆、情绪判读、群聊仿真、日记与手机/QQ 空间扩展都在本地跑。
>
> **不是什么**：不是一个开箱即用的聊天机器人，也不是 SnowLuma / DSH 的发行版。
> 项目处于早期、自用为主：接口和提示词会变，没有一键安装包，Windows 优先。

## 特性

| | |
|---|---|
| **长期记忆** | 纯文本 JSONL，本地 bge-m3 语义召回 + 可选交叉重排；私聊/群聊分库，按时间与重要度注入 |
| **群聊仿真** | 观望 / 活跃 / 试探 / 退场状态机；二代模式由 agent 自己看消息、决定开口与潜水 |
| **会判断场合** | 规则优先，拿不准时用本地 3B 判情绪/意图；模型不可用自动降级，不阻塞回复 |
| **她自己的生活** | 定时静默唤醒、日记、认知与经验沉淀（`own-life` / `diary` / `lesson`） |
| **安全边界** | 白名单入口、QQ 工具安全子集、MCP SSRF 防护；群友物理上碰不到本地工具 |
| **本地控制台** | `127.0.0.1:3100`：模式、人格、白名单、记忆、表情、token 花费、日志 |
| **可扩展** | `ai-companion-kit` 提供记忆、日记、手机、QQ 空间等 MCP 包 |

## 架构

```text
QQ  ←──►  SnowLuma（OneBot v11，第三方）  ←──►  qq-bridge  ──►  DSH Web（3080）
                                                    │                agent
                                                    │                  │
                                                    └──── 回复 / 工具审批 ┘
                                                    │
                              data/（记忆·日记·认知·经验） + 本地模型（可选）
```

| 目录 | 作用 |
|---|---|
| [`qq-bridge/`](qq-bridge/) | 消息路由、会话、人格、记忆、仿真、控制台、安全 MCP |
| [`ai-companion-kit/`](ai-companion-kit/) | 记忆 / 日记 / 手机 / QQ 空间等扩展包（MIT） |
| [`docs/`](docs/) | 架构、部署、发布与维护文档 |
| `data/` | 运行期数据（默认不提交；见[数据与隐私](#数据与隐私)） |
| `logs/`、`snowluma/` | 运行日志与第三方网关（默认不提交） |

更细的模块、数据流和端口见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

> 完整步骤、配置项和排错见 **[docs/deployment.md](docs/deployment.md)**。
> 下面是骨架，帮助你判断要不要继续。

### 要求

- Windows 10/11（主要验证环境；Linux/macOS 未验证）
- Node.js **>= 22.13**
- 一个可用的 **DSH Web** 运行时（`dsh web`，默认 `127.0.0.1:3080`）
- **SnowLuma**：第三方 QQ 网关，需要你自己下载、安装、扫码；本仓库**不分发**它
- 可选：Python 3.10+（手机/重排脚本）、llama.cpp（本地嵌入/3B）

### 步骤

```bash
git clone <this-repo> qq-inori
cd qq-inori/qq-bridge
npm install
cp config.example.json config.json        # 填 ownerQQ、SnowLuma accessToken、白名单
cp allowlist.example.txt allowlist.txt    # 填 private:QQ / group:群号
node scripts/setup-dsh.mjs web            # 安装 agent preset 与 MCP（会改 ~/.dsh）
npm start                                 # 桥接；控制台 http://127.0.0.1:3100
```

1. 先启动 DSH Web（3080）。
2. 自行启动 SnowLuma，用**小号**扫码登录（不要用主号）。
3. 把 SnowLuma 的 access token 填进 `config.json` 的 `snowluma.accessToken`。
4. 人格卡：把 [`docs/examples/persona.example.md`](docs/examples/persona.example.md)
   复制到 `qq-bridge/roles/`，在控制台「人格与角色」里选中。
5. 看到日志出现 `DSH 已就绪` 即成功。

### 启动脚本（示例）

一键脚本里有作者本机的路径与计划任务，**不进仓库**（`.gitignore` 忽略 `*.bat` / `*.vbs`）。
仓库只带可改的示例，复制成 `.bat` 后按本机改：

| 文件 | 作用 |
|---|---|
| [`scripts/windows/start-all.bat.example`](scripts/windows/start-all.bat.example) | 拉起嵌入（可选）→ DSH → SnowLuma（自行启动）→ 桥接 |
| [`scripts/windows/stop-all.bat.example`](scripts/windows/stop-all.bat.example) | 按端口停掉本项目默认监听 |

开机自启请用任务计划/服务管理器自行配置；完整步骤见 [docs/deployment.md](docs/deployment.md)。

## 配置

| 文件 | 说明 |
|---|---|
| `qq-bridge/config.example.json` | 完整配置模板（模型、端口、白名单、模式、记忆、仿真） |
| `qq-bridge/allowlist.example.txt` | 入口白名单格式；复制为 `allowlist.txt` 后生效 |
| `docs/examples/persona.example.md` | 人格卡示例；复制到 `qq-bridge/roles/` |
| `qq-bridge/state/console-token` | 控制台令牌（首次启动自动生成，**不要提交**） |

## 本地模型（可选）

不装也能跑：记忆检索会退回字面匹配，情绪判读退回规则。

| 模型 | 端口 | 用途 | 启动方式 |
|---|---|---|---|
| bge-m3（嵌入） | 8790 | 记忆召回、唤醒门、接话检查 | 常驻；llama.cpp `--embedding` |
| Qwen2.5-3B（Q4_K_M） | 18080 | 情绪/意图判读、群事实与记忆抽取 | 按需；闲置 10 分钟自动退 |
| bge-reranker-v2-m3 | 8792 | 记忆召回重排 | 按需 |
| ONNX 情绪分类器 | 8793 | 3B 冷启动时兜底 | 按需 |

细节和失败降级见 [docs/architecture.md](docs/architecture.md#本地模型)。

## 数据与隐私

- 所有数据都在本机：记忆 `data/memory/`、状态 `data/state/`、日志 `logs/`。
- 仓库**不含**任何真实 QQ 号、群号、聊天记录、人格卡、记忆库或令牌。
- 桥接只处理 `allowlist.txt` 里的会话；其余在入口丢弃。
- 会出机的只有：DSH 里发给模型的内容、可选联网搜索的关键词，以及 SnowLuma 自己的协议流量。
- 公开仓库里不要提交：`qq-bridge/config.json`、`state/`、`data/`、`logs/`、
  `qq-bridge/roles/`、`qq-bridge/allowlist.txt`、`snowluma/`。详见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 开源范围与第三方

- 本仓库代码：**MIT**（见 [LICENSE](LICENSE)）。
- `qq-bridge/`、`ai-companion-kit/` 各自也是 MIT。
- **来源**：这两个目录分别是两个 MIT 上游项目的快照，之后在本仓库继续开发；上游版权声明保留在各自目录的 `LICENSE` 里，
  快照版本、许可变更与核对结论见 [NOTICE.md](NOTICE.md)。
- **SnowLuma 不在本仓库内**：它采用「源码可见非商业许可」，binary 与原生模块属专有组件，
  再分发/自动部署需要授权。请自行获取并遵守其 EULA；本项目只探测，不安装、不启动、不控制。
- DSH 是外部运行时，不在本仓库内。
- 人格卡是**同人演绎 / 虚构角色**：示例与任何真实人物无关；你自建的角色由你负责。

> ⚠️ 用非官方协议接入 QQ 可能违反平台条款并导致账号风险。请用**小号**，风险自负。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/deployment.md](docs/deployment.md) | 从零部署、配置、端口、排错 |
| [docs/architecture.md](docs/architecture.md) | 模块、消息流、记忆管线、本地模型（短版） |
| [docs/architecture-full.md](docs/architecture-full.md) | 全栈架构与原理（含无本地模型的四档部署方案） |
| [docs/ENGINEERING_DISCIPLINE.md](docs/ENGINEERING_DISCIPLINE.md) | 改动前必读：计划、接缝规则、验证、文档同步 |
| [docs/README.md](docs/README.md) | 文档索引与写作约定 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 开源发布检查单（维护者） |
| [qq-bridge/README.md](qq-bridge/README.md) | 桥接的完整说明（中文） |
| [qq-bridge/src/onebot/README.md](qq-bridge/src/onebot/README.md) | OneBot 入站/心跳适配层契约与测试 |
| [qq-bridge/README.en.md](qq-bridge/README.en.md) | Bridge guide (English) |
| [ai-companion-kit/README.md](ai-companion-kit/README.md) | 扩展包说明 |

## 开发

```bash
cd qq-bridge
npm test              # docs:check + matrix:check + audit:arch + audit:wiring + test:core
npm run test:core     # 纯模块/契约测试
npm run test:inori    # 仿真/记忆/性格等行为测试
npm run doctor:config # 配置体检
npm run docs:check    # 必读文档/本地链接/变更记录门禁
npm run health        # 全栈健康检查
```

约定：零新增运行时依赖（除非有明确理由）；先改测试再改行为；业务代码只放
`qq-bridge/src/` 或 `ai-companion-kit/packages/*/src/`。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE) © 2026 Derpyu520 and QQ Inori contributors
