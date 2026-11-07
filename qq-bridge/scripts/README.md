# scripts 目录约定

这个目录同时包含持续测试、运维入口、评估工具和历史手工脚本。为了避免再次出现“文件还在，但没人知道能不能删、什么时候运行”的情况，新增脚本按以下规则命名和归类。

## 分类

- `test-*.mjs`：可重复执行、默认不修改生产数据的持续测试。
- `eval-*.mjs`：只读评估；产物写入独立评估目录。
- `restart-*.mjs`、`setup-*.mjs`、`harden-*.mjs`：正式运维入口。
- `diagnostics/`：可重复执行的现场诊断工具。
- `migrations/`：需要人工确认的数据迁移，必须先备份或支持 dry-run。
- `_*.mjs`：历史过渡命名。新增脚本不再使用含义不明的 `_` 前缀。

## `_*.mjs` 处置结果（2026-10-27 完成）

`scripts/` 下已无 `_` 前缀脚本。原清单去向：

| 原文件 | 现在位置 | 说明 |
| --- | --- | --- |
| `_fix-config-minsim.mjs` | `archive/oneoff-scripts/fix-config-minsim.mjs` | 一次性配置迁移，已完成使命 |
| `_patch-busycap.mjs` | `archive/oneoff-scripts/patch-busycap.mjs` | 补丁已由当前源码吸收 |
| `_smoke.mjs` | `archive/oneoff-scripts/learning-store-smoke.mjs` | 临时回归，已归档 |
| `_style-weekly.mjs` | `scripts/eval-style-weekly.mjs` | 改名并改用 `project-paths` |
| `_test-recall-sentinel.mjs` | `scripts/eval-recall-sentinel.mjs` | 改名并改用 `project-paths` |
| `_gate-dist.mjs` | `scripts/diagnostics/gate-dist.mjs` | 见下表 |
| `_psinfo.mjs` | `scripts/diagnostics/psinfo.mjs` | 见下表 |
| `_refcheck.mjs` | `scripts/diagnostics/refcheck.mjs` | 见下表 |
| `_snap.mjs` | `scripts/diagnostics/runtime-snapshot.mjs` | 见下表 |

## diagnostics/ 清单

2026-10-27 从 `_*.mjs` 迁入，并改为经 `src/domain/shared/project-paths.js` 取路径（不再写死 `<repo>`）：

| 文件 | 用途 | 对应 npm 脚本 |
| --- | --- | --- |
| `diagnostics/gate-dist.mjs` | 统计 attention gate 粗筛分布与阈值曲线 | `diag:gate` |
| `diagnostics/runtime-snapshot.mjs` | 各会话未读水位 + 日志尾部 | `diag:snapshot` |
| `diagnostics/refcheck.mjs` | 粗略统计符号在 `bridge.js` 的引用次数（可传自定义符号） | `diag:refcheck` |
| `diagnostics/psinfo.mjs` | 查指定 PID 的命令行与进程名 | `diag:psinfo` |
| `diagnostics/disk-guard.mjs` | C 盘水位 + `%TEMP%\dsh-workspace-changes-*` 快照巡检；默认 dry-run，`--apply` 清过期目录 | `diag:disk` |

## 测试入口（2026-10-28 统一）

测试原本散在 4 个位置、由 2 个互不覆盖的执行器跑（`npm test` 还硬编码了 21 个文件名）。
现在：

| 命令 | 作用 |
| --- | --- |
| `npm test` | `docs:check` + `matrix:check` + `audit:arch` + `audit:wiring` + `test:core`（门禁链；`test:inori` 为独立可选子集） |
| `npm run test:draft` | 已归档的草案测试（`archive/drafts/session-router/session-router.test.mjs`）——默认不跑，别把它当覆盖率 |
| `npm run test:audit` | 审计套件（`test-audit.mjs`，当前 78 项） |
| `npm run test:all` | `run-all-tests.mjs`：自动发现 4 个位置的全部测试，逐个跑（串行） |

`run-all-tests.mjs` 只按约定发现，不再维护清单。它会扫：

- `test/**/*.test.{mjs,js}` 与根目录 `test-*.test.mjs`（单元层）
- `scripts/test-*.mjs`（历史脚本测试）
- `../_src/test_*.mjs`（本机脚本测试）
- `--draft` 加上 `archive/drafts/**/*.test.mjs`（已归档草案）
- `--kit` 加上 `ai-companion-kit/tests/`（默认不跑，多数需要真机/真服务）

参数：`--list`（只看发现结果）、`--unit` / `--legacy`（只跑一层）、`--only=关键词`、`--timeout=毫秒`。
报告写到 `state/test-report-all.json`。

## 配置体检

`config-doctor.mjs` 回答两个问题：config.json 里有没有「写了但加载器不认识」的键；
config.example.json 有没有落后于现网（照 example 新装会静默丢功能）。

```powershell
npm.cmd run doctor:config            # 静态：只比 config.json / example 的形状
npm.cmd run doctor:config -- --runtime --strict   # 让桥接以 BRIDGE_CONFIG_CHECK=1 跑一次 loadConfig（不连 DSH、不抢锁）
```

`--strict` 下有任何「会被静默丢弃的键」或 example 缺键就返回 1。

## 健康检查

`health-check.mjs` 是只读的全栈检查入口：桥接 3100（带控制台令牌）、OneBot 3000、DSH 3080、嵌入 8790、第二大脑 3081（可选）、重排 8792（可选）。超时 2s，`--json` 机器读，`--strict` 把 8792 也算必需，退出码 0/1/2 对应健康/掉线/自身出错。

```powershell
npm.cmd run health
npm.cmd run health -- --json
```


## 跨域只读总览

`state-overview.mjs` 把任务台账、人物/关系图、生图/表情库和学习摘要读成一个只读模型，不合并存储、不改源账本：

```powershell
npm.cmd run state:overview             # 写 data/state/overview.json + overview.md
npm.cmd run state:overview -- --dry-run
npm.cmd run state:overview -- --json
```

模型入口是 `src/inori-overview.js` 的 `collectOverview()`；控制台只读接口是 `GET /api/state/overview`。学习侧明细仍以 `learning-report.md` 为准，总览只引用 `learning-report-summary.json`。

## 安全要求

- 持续测试必须使用临时目录，不读取或修改 `qq-bridge/state/` 和 `data/` 的生产文件。
- 会修改 `config.json`、记忆或状态的脚本必须明确打印目标路径，并提供备份或 dry-run。
- 诊断脚本默认只读；需要重启或清理时使用正式运维入口。
- 一次性脚本完成使命后移动到仓库根目录的 `archive/oneoff-scripts/`，不要直接删除以免丢失迁移背景。
