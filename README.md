# 需求助手 —— 飞书机器人 × DeepSeek API（独立服务）

在飞书里和「需求助手」对话：飞书机器人收消息 → 直接调用 **DeepSeek API（deepseek-v4-pro，推理强度 max）** → 回复发回飞书。**不依赖 DeepSeek Harness**，是一个独立的 Node.js 服务。

内置：提示词可配置、对话按项目区分、聊天记录落盘、未回答检测 + 运营看板 + 飞书告警、历史聊天记录作为项目上下文。

## 架构

```
飞书聊天（私聊 / 群里@机器人）
   ↓ 长连接事件 im.message.receive_v1（免公网）
src/feishu.js（@larksuiteoapi/node-sdk）
   ↓
src/server.js（命令解析 / 项目路由 / 会话记忆）
   ↓
src/llm.js → DeepSeek API（/chat/completions，deepseek-v4-pro + reasoning_effort=max）
   ↓
回复流式发回飞书（长文本自动分片）

旁路：src/store.js 聊天记录 JSONL 落盘 → src/monitor.js 未回答检测
      → src/dashboard.js 运营看板（HTTP，默认 http://127.0.0.1:3800/）+ 飞书告警
```

## 快速开始

```powershell
cd D:\Workspace\需求助手
npm install                     # 已装可跳过
Copy-Item .env.example .env     # 填入 FEISHU_APP_ID/SECRET、DEEPSEEK_API_KEY
npm start
```

启动后：
- 运营看板：<http://127.0.0.1:3800/>
- 飞书私聊机器人，发 `/help` 看全部命令
- 缺飞书凭据时通道自动禁用（打印提示），服务与看板不受影响；缺 DeepSeek key 时回答报错并记录/告警

## 本地测试（不建飞书应用也能全链路测）

```powershell
npm test                 # 单元冒烟（21 项，不接网络）
node tests/live-llm.mjs  # 真实 DeepSeek API 冒烟（需 DEEPSEEK_API_KEY）
npm run chat             # ★ 终端模拟飞书对话：直接提问/发命令，
                         #   走与飞书完全相同的处理链路（模型/项目/记录/未回答检测），
                         #   聊天记录同样写入 data/，可回看板查看；/exit 退出
```

真飞书端到端：本机 `npm start` + 飞书后台「创建测试版本」即可（长连接免公网，见下一节第 5 步）。

## 飞书应用配置（一次性，约 10 分钟）

1. [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**（个人/商店应用不支持长连接）
2. 添加应用能力 → 开启「机器人」
3. 「凭证与基础信息」记录 **App ID**（`cli_` 开头）与 **App Secret** → 填入 .env
4. 「权限管理」添加：`im:message.p2p_msg:readonly`（收单聊）、`im:message:send_as_bot`（回复）；群聊再加 `im:message.group_at_msg:readonly`；**处理文件/图片再加 `im:resource`**（获取消息中的资源文件）
5. 「开发配置 → 事件与回调 → 事件配置」：订阅方式选「**使用长连接接收事件**」，添加事件 `im.message.receive_v1`
6. 「权限管理 → 可用范围」加入自己和团队成员
7. 「应用发布」创建版本并**申请线上发布**（每次改权限/事件后都要重新发布）

## 部署到公网服务器

长连接方案在公网服务器上**更省事**：服务只做主动出站连接，**不需要给飞书配回调地址、不需要 HTTPS 证书、不需要开任何飞书方向的入站端口**。

1. 服务器装 Node.js 22+，把本目录整个上传（排除 `node_modules/`、`data/`）
2. `npm install` → 复制 `.env.example` 为 `.env` 填凭据
3. 启动：
   ```powershell
   npm start
   # 或进程守护（推荐）：
   npm i -g pm2; pm2 start src/server.js --name req-assistant; pm2 save; pm2 startup
   ```
4. **远程访问运营看板**（可选）：`.env` 里设
   ```
   ADMIN_HOST=0.0.0.0
   ADMIN_TOKEN=你的随机长令牌
   ```
   访问：`http://<服务器IP>:3800/?token=<你的随机长令牌>`；不配令牌不要放开到 0.0.0.0（默认只绑 127.0.0.1，仅本机可看）。
5. 防火墙只需放行看板端口（3800）；飞书/DeepSeek 方向全部是出站 HTTPS，无需入站规则。
6. 数据备份：`data/`（聊天记录/项目/会话记忆）、`projects/`、`config.json`。

## 模型配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | 模型名 |
| `REASONING_EFFORT` | `max` | 推理强度 min/low/medium/high/max；留空则不传 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 换网关/代理时改 |
| `DEEPSEEK_API_KEY` | — | 必填 |
| `MAX_TOKENS` | 8000 | 单次回复上限 |

已用真实 key 联调验证：deepseek-v4-pro + max 正常返回（reasoning_tokens 生效，见 tests/live-llm.mjs）。

**每项目覆盖模型**：编辑 `config.json` 的 `projects.<id>.model {model, reasoningEffort, maxTokens}`，即时生效。

## 提示词配置（三种途径）

1. **全局系统提示词**：`config.json` 的 `systemPrompt`（热更新，改完即生效）；或在飞书里发 `/prompt set <文本>`、`/prompt view` 查看。
2. **每项目提示词与文档（推荐）**：`项目资料/<项目名>/` 目录 —— `提示词.md` 为本项目专属提示词（覆盖全局），目录下其他 .md/.txt 自动注入本项目对话（合计约 30KB）。改文件**即时生效，无需重启**。用法见 `项目资料/README.md`。
3. **兼容方式**：`config.json` 的 `projects.<id>.prompt`（覆盖全局）。

上下文注入：服务自动把 `AGENTS.md`（历史对话压缩产物）追加进系统提示词。

参考提示词：[需求助手提示词.md](需求助手提示词.md)。

## 按项目区分对话（/project）

同一飞书聊天里可维护多个项目，**每项目独立对话记忆、独立提示词、独立模型、独立上下文目录**：

| 命令 | 效果 |
|---|---|
| `/project new <名称>` | 新建项目并切换（自动生成 `项目资料/<名称>/` 的提示词与文档模板） |
| `/project use <名称|id>` | 切换项目（原项目对话保留，切回可继续） |
| `/project list` | 列出项目（\* = 当前） |
| `/project current` | 当前项目与模型 |
| `/new` | 清空当前项目对话重新开始 |
| `/status` | 通道/模型/项目/未回答状态 |

项目数据：`data/projects.json`；激活关系按聊天维护。

## 飞书文件与图片

- **文本类文件**（txt/md/csv/json/log 等）：自动下载落盘 → 内容抽取进对话（上限 2 万字符，超出截断）→ 模型基于文件内容回答。
- **图片**：自动下载落盘；`.env` 填 `VISION_MODEL` 即启用视觉识别（OpenAI 兼容格式，兼容 qwen-vl / glm-4v / gpt-4o 等任何网关；默认复用 DEEPSEEK 的 BASE_URL/KEY，也可用 `VISION_BASE_URL`/`VISION_API_KEY` 单独指定）。识别结果回复飞书并进会话记忆与聊天记录；未配置时仅落盘。
- **PDF**：自动抽取文本层内容进对话（上限 2 万字符）；扫描件/图片型 PDF 无文本层时会明说，可配视觉模型后改发截图。
- **Word/Excel 等其余二进制**：落盘保存，提示转为文本或放入工作区目录。
- 落盘位置：`data/inbox/<chatId>/`；每条附件记入聊天记录（kind=attachment，不参与未回答判定）。
- 权限前提：飞书后台开通 `im:resource`；单文件 100MB 以内。

## 聊天记录入库

- 所有聊天内容（用户消息/助手回复/错误/命令/未回答判定/运营处理）结构化落盘：`data/records/records-YYYY-MM-DD.jsonl`（保留 90 天）。
- **数据库设计已就绪**：MySQL 8，5 张表（chat_records / projects / chat_project_active / question_status / alerts），DDL 见 [docs/db/schema.sql](docs/db/schema.sql)，设计说明见 [docs/数据库设计.md](docs/数据库设计.md)。
- 存储层按 `RecordSink` 接口设计（append/readRange/…）——确认库名/表前缀后，我实现 store-sql.js（mysql2）替换 JSONL 即入库，历史 JSONL 按 record_uuid 幂等导入。

## 监控运营：检测用户的问题是否被回答

- **规则**：非命令的用户消息超过 `UNANSWERED_TIMEOUT_SEC`（默认 600 秒）无助手回复 → 判「未回答」；LLM 调用失败 → 「回答异常」。每分钟扫描。
- **运营看板**：<http://127.0.0.1:3800/> —— 今日统计、未回答清单（可标记已处理）、今日各项目回答情况、近 7 天回答率、会话列表与对话明细。
- **飞书告警**：`.env` 的 `ALERT_CHATS` 填管理员 open_id（如 `feishu:ou_xxx`，逗号分隔），检测到未回答/回答异常即私聊告警。
- **JSON API**：`/api/status` `/api/chats` `/api/records` `/api/projects` `POST /api/resolve` —— 供对接你们自己的运营系统。

## 历史聊天记录作为项目上下文

1. 把历史记录放入 `context/raw/`（txt/md/csv/jsonl，格式见 [context/README.md](context/README.md)）
2. 运行 `node scripts/build-context.mjs`（可选 `--summarize` 用 DeepSeek 逐块摘要）
3. 生成 `AGENTS.md`（压缩上下文）+ `context/chunks/`（全文分块）；服务自动注入提示词

## 目录结构

```
需求助手/
├─ README.md / .env.example / .gitignore
├─ package.json
├─ config.json              全局系统提示词 + 每项目覆盖（热更新）
├─ src/
│   ├─ server.js            入口：装配 + 命令 + 消息处理 + HTTP 看板
│   ├─ config.js            环境变量/.env 与 config.json 加载
│   ├─ feishu.js            飞书长连接收发
│   ├─ llm.js               DeepSeek API 客户端
│   ├─ memory.js            会话记忆（按聊天+项目隔离，持久化）
│   ├─ projects.js          项目注册表（data/projects.json）
│   ├─ context.js           系统提示词组装（含上下文注入）
│   ├─ store.js             记录存储（RecordSink/JSONL，DB 适配点）
│   ├─ monitor.js           未回答检测 / 标记处理
│   ├─ commands.js          命令解析与帮助
│   └─ dashboard.js         运营看板页面
├─ tests/
│   ├─ smoke.mjs            单元冒烟（npm test）
│   └─ live-llm.mjs         真实 API 冒烟（需 DEEPSEEK_API_KEY）
├─ scripts/build-context.mjs  历史记录 → 上下文
├─ context/                 历史记录 raw/、样例、分块输出
├─ 项目资料/                 ★ 每项目的提示词与文档（按项目名，自动生效，见目录内 README）
├─ data/                    运行数据（records/projects/memory，.gitignore）
└─ projects/                （旧版每项目上下文目录，已由 项目资料/ 取代）
```

## 测试方法

```powershell
npm test                          # 单元冒烟（21 项，不接网络）
node tests/live-llm.mjs           # 真实 DeepSeek API 冒烟（需 key）
npm start                         # 完整启动：看板 3800 + 飞书通道
```

## 待你提供

1. **数据库及表结构** → 实现 store-sql.js 入库适配器（记录字段见 src/store.js）。
2. **历史聊天记录文件** → 放入 context/raw/ 后运行加工脚本。
