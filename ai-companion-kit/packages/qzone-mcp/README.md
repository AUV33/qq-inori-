# qzone-mcp

让 AI 自己发 QQ 空间说说。

不是定时发——**定时发的第一条说说，观众一眼就能看出来是机器人**。这个包给的是「她想说的时候，能自己开口」的能力。

```
发说说 · 看好友动态 · 看某人的说说 · 点赞 · 评论
```

**没有删除，没有拉黑。** 发出去的话收不回来，这是故意的。

---

## 它解决什么问题

QQ 空间没有开放的写接口。想用程序发说说，通常得走浏览器自动化（不稳定、会被风控），或者拿小号手动登。

这个包走的是**已经登录着的 QQ 客户端**：本地跑一个 [SnowLuma](https://github.com/) 网关（把 QQ 包成 OneBot 接口），MCP 调它的 `send_qzone_msg` / `get_qzone_feeds` 等动作。

所以：

- **不需要你的 QQ 密码**
- **不需要开浏览器**
- **不碰 QQ 的登录态**

只要能连上本机 `127.0.0.1:3000`，就能发。

---

## 前提

| 需要 | 说明 |
|---|---|
| Node ≥ 18 | |
| SnowLuma 在跑 | OneBot HTTP 监听 `127.0.0.1:3000`，QQ 已登录 |
| 访问令牌 | SnowLuma 的 `accessToken`（下面三种方式任选） |

### 令牌从哪来

按优先级自动找：

1. 环境变量 `SNOWLUMA_ACCESS_TOKEN`
2. `config.json` 里的 `snowluma.accessToken`（qq-bridge 的配置）
3. SnowLuma 自己的 `config/onebot_<QQ号>.json`

不用手填也行——找到哪个用哪个。

---

## 装

```bash
npx qzone-mcp
```

或者本地拉下来：

```bash
git clone <本仓库>
cd packages/qzone-mcp
npm install
node src/qzone-mcp.js --selftest     # 先验一下通不通
```

`--selftest` 会打印：

```
OneBot 地址: http://127.0.0.1:3000
令牌: 已拿到（32 字符）
允许发图的目录: <repo>/data/pics , <repo>/data/workshop
连通性: ✅ 能取到自己的说说
```

---

## 配到 MCP 客户端

DeepSeek Harness / Claude Desktop / Cursor 之类，都是同一段 JSON：

```json
{
  "mcpServers": {
    "qzone": {
      "command": "node",
      "args": ["E:\\你的路径\\packages\\qzone-mcp\\src\\qzone-mcp.js"],
      "env": {
        "SNOWLUMA_HTTP_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

对着自己电脑上那个 `node.exe` 的绝对路径填 `command` 更稳（Windows 上尤其）。

---

## 十一个工具

| 工具 | 干什么 | 限额 |
|---|---|---|
| `qzone_post` | 发一条说说（可带图，最多 9 张；可见性 `ugcRight` 默认 4=好友可见） | 每分钟 3 次、每天 20 次 |
| `qzone_my_posts` | 看自己发过什么 | — |
| `qzone_feeds` | 看好友动态（带 tid） | — |
| `qzone_user_posts` | 看某个人的说说（传 QQ 号） | 每 3 分钟 5 人、每天 40 次 |
| `qzone_like` | 给一条说说点赞 | 共享总额 |
| `qzone_unlike` | 取消赞 | 共享总额 |
| `qzone_comment` | 评论一条说说（可带图） | **每 10 分钟 2 条、每天 10 条** |
| `qzone_recent_like` | 给最新一条直接点赞（按昵称找） | 共享总额 |
| `qzone_images` | 看图库里有哪张图可以配（可按分类/备注/标签搜） | — |
| `qzone_pic_save` | 把喜欢的图存进图库（分类文件夹 + 一句备注，按内容去重） | — |
| `qzone_delete` | 删自己发错的说说（删了恢复不了） | — |
| `qzone_set_right` | 改已发说说的可见性 | — |

评论限得最狠，因为**评论发出去撤不回来**（QQ 空间没有删评论的接口）。想表达喜欢，点赞优先。

---

## 发图

图只能来自这几个目录（默认按仓库位置推算，`QZONE_IMAGE_DIRS` 可覆盖）：

```
<仓库>\data\pics        （图库；不存在会自动建）
<仓库>\data\workshop    （她工坊里存下的图）
%USERPROFILE%\Pictures
```

改目录，多个用 `;` 分隔：

```bash
QZONE_IMAGE_DIRS="<图片目录>;<图片目录>" node src/qzone-mcp.js
```

**不在目录里的路径会被拒绝**——防止 AI 不小心把你桌面上什么东西发出去。

`http(s)` 图片链接直接放行，交给 OneBot 去下。

配图前让她先 `qzone_images` 看一眼图库里有什么；`images` 里**只写文件名也行**（会去图库/工坊里找）。

图库按主题分文件夹：`data/pics/夜里/…`、`data/pics/猫/…`。`qzone_pic_save` 存图时会写一句备注到
`data/pics/index.json`（为什么存、适合什么情绪），`qzone_images` 的关键词会一起搜文件名 + 文件夹 + 备注 + 标签，
所以她能按情绪找图，而不是对着 `IMG_1234.jpg` 猜。

**图文要对得上**：`qzone_post` / `qzone_comment` 的工具描述里写死了「图要跟正文同一种情绪、或者内容上是一件事；
凑不出就纯文字发」。这是刻意的——随手抓一张图配上去，比不配图更像机器人。

上传流程不在这里实现：SnowLuma 的 `send_qzone_msg` 会先逐张上传拿 `richval` 再发说说
（和 aioqzone 的 `upload_pic → preupload_photos → publish_mood` 一个思路）。

---

## 常见问题

**「拿不到访问令牌」**

SnowLuma 没跑，或者配置里没 `accessToken`。先跑 `--selftest` 看它找到哪一步了。

**「看对方空间失败：主人设置了保密」**

对方设了权限。这是正常的，换个目标，别反复试同一个——会触发风控。

**「查得太快被 QQ 限流」**

翻别人空间有频率限制。歇几分钟。日志里会刷 `WARN` 就是这个。

**发图片失败**

先确认图在允许的目录里，再确认 SnowLuma 那边 `send_qzone_msg` 的 `images` 吃的是绝对路径。

---

## 为什么不给删除和拉黑

一个跑在你电脑上、能自己说话的东西，如果还能删东西，那它哪天判断失误，你连「它删了什么」都查不到。

创作类能力放开，破坏类能力不给。这是这个方法里最要紧的一条。

---

## 许可证

MIT
