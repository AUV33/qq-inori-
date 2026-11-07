# AI Companion Kit · QQ Inori 扩展包

这个目录是 QQ Inori 用到的扩展包集合：记忆账本、日记导出、安卓手机控制、QQ 空间、
她自己的生活节奏，以及几个共享库。

`qq-bridge` 直接以相对路径 import 这些包；只有带 MCP 服务器的包（`phone-mcp`、
`memory-mcp`、`diary-mcp`、`qzone-mcp`）会被 DSH 以 stdio 方式单独拉起。

> 来源说明见根目录与各子目录的 LICENSE 中的上游版权声明。

### 注册到 DSH（首次部署）

`node scripts/setup-dsh.mjs web`（在 `qq-bridge/` 下）只托管 3 个桥接自带的**安全** MCP
（`snowluma` / `snowluma-host` / `web-search-safe`）。下面 4 个扩展包是「手工注册」的：
Guard 白名单（`qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES`）
已经放行对应前缀，但 DSH 侧需要你自己把 server 加进 profile，否则她看得到白名单却拿不到工具。

前置：`cd ai-companion-kit && npm install`（4 个包都是 workspaces，需要 `@modelcontextprotocol/sdk` 与 `zod`）。

在 `~/.dsh/profiles/web/cordis.patch.yml`（profile 名以你实际用的为准）追加下列 `insert` 条目，
`command` 填 `node`（或你的 Node 可执行文件绝对路径），`args` 里的 `<repo>` 换成你克隆仓库的
根目录（Windows 用反斜杠或正斜杠均可）：

```yaml
- insert:
    - id: mcp-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory        # 对应工具前缀 mcp__memory__
        transport: stdio
        command: node
        args: ['<repo>/ai-companion-kit/packages/memory-mcp/src/memory-mcp.js']
- insert:
    - id: mcp-diary
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: diary         # mcp__diary__
        transport: stdio
        command: node
        args: ['<repo>/ai-companion-kit/packages/diary-mcp/src/diary-mcp.js']
- insert:
    - id: mcp-phone
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: phone         # mcp__phone__
        transport: stdio
        command: node
        args: ['<repo>/ai-companion-kit/packages/phone-mcp/src/phone-mcp.js']
- insert:
    - id: mcp-qzone
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qzone         # mcp__qzone__
        transport: stdio
        command: node
        args: ['<repo>/ai-companion-kit/packages/qzone-mcp/src/qzone-mcp.js']
```

改完**重启一次 DSH**（preset/MCP 只在启动时加载）。可用 `node <入口> --selftest` 先自检
（`phone-mcp` / `qzone-mcp` 支持；`memory-mcp` 用根目录 `npm test`）。

> `mcp__prts__`（明日方舟 PRTS wiki，只读）不在本仓库内，是外部 MCP server，需自行部署后
> 按同样格式注册。它不是死条目：`qq-bridge/src/domain/leaves/inori-knowledge.mjs` 的
> `KNOWLEDGE_TOOLS` 会消费 4 个 `mcp__prts__*` 工具做知识沉淀。若你不部署它，删掉
> `cordis.patch.yml` 里对应条目即可；Guard 白名单里留着前缀不会带来权限问题（前缀放行不等于工具存在）。

### phone-mcp 本地视觉前置（OCR / 模板匹配）

`phone_ocr` / `phone_find_template` / `phone_tap_template` 依赖常驻 Python 视觉服务，
**未安装不影响其他 30 多个工具**，只是这几个会报「识别服务未安装」。安装方法：

```bash
cd ai-companion-kit/packages/phone-mcp
python -m venv .venv
.venv\Scripts\pip install rapidocr_onnxruntime opencv-python-headless   # Windows
# .venv/bin/pip install rapidocr_onnxruntime opencv-python-headless      # Linux/macOS
python vision/selftest_phone_vision.py
```

服务默认监听 `127.0.0.1:8791`，首次调用由 `src/local-vision.js` 自动拉起，日志在
`vision/phone-vision.log`。`.venv` 与日志都被 `.gitignore` 排除，不会进仓库。

## 包一览

| 包 | 作用 |
|---|---|
| `packages/shared` | 共享小库：路径推导、学习账本、游戏资源记录 |
| `packages/companion` | 陪聊骨架：角色卡 + 按人存的记忆 + 拟人化发送（示例在 `examples/`） |
| `packages/own-life` | 她自己的生活节奏：定时静默唤醒，不进聊天 |
| `packages/memory-mcp` | 记忆 MCP：按人/按群存与取 |
| `packages/diary-mcp` | 日记 MCP：写日记、导出成桌面 txt |
| `packages/phone-mcp` | 安卓手机 MCP：点按、滑动、输入中文、截图、录屏、跑宏 |
| `packages/qzone` | QQ 空间开通向导（往角色卡里加一段使用说明） |
| `packages/qzone-mcp` | QQ 空间 MCP：发说说、看动态、点赞、评论（不提供删除/拉黑） |

## 直接运行

```bash
# 手机 MCP（stdio，给 DSH / 其它 MCP 客户端用）
node packages/phone-mcp/src/phone-mcp.js

# 手机自检
node packages/phone-mcp/src/phone-mcp.js --selftest

# QQ 空间 MCP 自检
node packages/qzone-mcp/src/qzone-mcp.js --selftest

# 陪聊示例
node packages/companion/examples/demo.js
```

## 配置

各包读环境变量或桥接的 `config.json`：

| 变量 | 用途 |
|---|---|
| `PHONE_ADB` | adb 路径（默认按仓库位置推导 `tools/platform-tools/adb.exe`） |
| `DIARY_EXPORT_DIR` | 日记导出目录（默认 `<用户目录>/Desktop/日记导出`） |
| `QQ_INORI_ROOT` | 仓库根（跨目录调用时用；不设则按文件位置推导） |
| `BRIDGE_DIR` | 桥接目录（`own-life` 等包读桥接状态时用） |

## 测试

本目录的 `tests/` 是手动探针（需要真实手机 / 网络 / SnowLuma），不进 CI；
桥接侧的单元测试在 `qq-bridge/test/`，`npm test` 会跑。

## 许可

MIT。版权与上游快照的来源见根目录与各子目录的 LICENSE。
