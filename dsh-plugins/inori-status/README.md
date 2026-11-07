# @local/inori-status

DSH Web GUI 的「数字伙伴状态面板」：左侧栏一个麦克风图标，点开是六个视图。

## 设计原则（照着成熟看板做的）

- **一屏一件事**（Stephen Few：把最重要的信息压到一屏、一眼能读完）——「现在」这一页只回答"她在干嘛"。
- **渐进披露**（Tufte 的去装饰）——长列表先给 3 条，其余收在「还有 N 条」里；长文本默认折叠。
- **每个概念只出现一次**：会话列表只在「关系」出现，情绪跟着会话走。
- **没有意义的数据不显示**：六种情绪全为 0 时只写一句；186 个人的信任/亲近都是 0.50 时只写一句。

## 六个视图

| 视图 | 回答什么 | 内容 |
| --- | --- | --- |
| 现在 | 她在干嘛 | 四项数字、今天的安排（当前那条加粗）、最近 6 个动作 |
| 状态 | 她怎么样 | 九项状态条、此刻六种情绪、说话风格、她不在的时候 |
| 关系 | 她跟谁 | 会话（带当前主导情绪）、群里的高频互动对、唤醒配置、群聊黑话 |
| 脑子 | 她想过什么 | 最近想明白的、攒下来的规矩、对人的判断、惦记的事 |
| 记录 | 她写了什么 | 三条日记、今天的小结、token 用量与常用工具、记忆条数 |
| 调试 | 怎么改她 | 当前 provider / model / 思考强度、运行状态；**热切换**思考强度、运行模式、暂停/恢复 |

## 调试视图的安全边界

- 写操作只有三条，且都走桥接控制台（3100）已经存在的端点，**不改她一行代码**：
  - `POST /api/dsh/effort` —— 思考强度，下一条消息生效（会同时写 DSH 全局默认，影响 Web GUI 新会话）
  - `POST /api/mode` —— 运行模式（chat / reserved / reserved2 / closed-agent）
  - `POST /api/socialV2/activity` —— 暂停/恢复二代 AI
- Host 侧只转发这三个动作，动作名和值都在白名单里校验过，其余一律 400。
- 每个写操作都要**二次确认**（点选项 → 出现「切到 X？」→ 确认）。
- **模型/供应商不在热切换范围**：桥接只在启动时读 `config.json` 的 `dsh.provider` / `dsh.model`，要换得改配置再重启桥接。面板只展示、并明确标注这一点，免得误以为点了没反应。
- 控制台令牌只在 Host 内部使用（读 `qq-bridge/state/console-token`），浏览器拿不到。

## 半侧

| 半侧 | 文件 | 作用 |
| --- | --- | --- |
| Host | `index.js` | 三个同源路由：`/inori-status/state.json`（快照）、`/inori-status/debug.json`（模型与运行状态）、`/inori-status/debug/action`（白名单写操作） |
| Client | `client.js` | `sidebar.panellist` 图标 + `main` 页面，每 15 秒拉快照；调试视图按需拉取 |

## 性能

- 大文件（slang 1.2 MB、social-graph 91 KB、beliefs 75 KB、token-usage 5.4 MB、tool-calls）按 **mtime + size 缓存**解析，重建失败沿用上一次的值。
- 大日志只读尾部：`token-usage` / `tool-calls` 各 512 KB，其它 JSONL 64 KB。
- `turn` 行没有会话 key 也没有 cost，所以只报当日输入/缓存/输出与模型名。

## 配置

`config.root` > 环境变量 `QQ_INORI_ROOT` > 按插件位置推导（`<repo>/dsh-plugins/inori-status` → `<repo>`）。

## 边界

- 除调试视图那三个热切换外，全部只读。
- `people.json` / `group-members.json` 是 aes-256-gcm 密文，面板不解密；人名来自 `social-graph.json`，缺失显示「匿名」。
- 文案走 client locale 命名空间 `inori-status`（zh / en），配色只用 `--dsw-alias-*` token。
- 改 `client.js` 由 client-hmr 推送；改 `index.js`（新增路由）需要重载 Host。
