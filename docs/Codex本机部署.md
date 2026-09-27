# Codex 需求助手：本机部署与使用

本服务通过本机 Codex App Server 处理飞书消息；模型推理仍使用远端服务。它独立于 Codex 桌面窗口运行，不控制鼠标键盘。电脑需保持联网、不休眠。

## 已实现

- Codex / DeepSeek 项目级后端选择；Codex 按渠道、用户ID、聊天、项目保存会话，重启后下一轮恢复。
- 全局单任务执行、持久化去重与任务状态；重启时未完成任务标记 interrupted，不自动重跑。
- `/task status` 查看状态，`/cancel [任务号]` 取消自己的任务，`/task resend [任务号]` 补发未送达结果。
- 结果保存后才发送；发送失败后台最多自动尝试三次，可手动继续补发。文本分片记录发送进度，使用稳定的飞书 uuid。网络回执与本地落盘之间仍存在极小的不确定窗口，不能保证跨任意时长的严格 exactly-once。
- Word `.docx` 标题段落表格；Excel `.xlsx` 工作表、坐标、公式和缓存值；PDF 分页文字与页面图片；PNG/JPEG/GIF/WebP 图片。
- 项目资料递归索引，附件按用户ID、聊天和项目隔离；通过文件编号访问，不允许工具传入任意本机路径。
- 新交付内容可另存为 Markdown 并回传飞书。原始项目资料不会被该工具覆盖。
- 解析在线程内运行，单次60秒、JS堆256MB上限；默认文件上限30MB。PDF每次读最多5页，图片渲染最长边受限制。
- 看板显示最近任务和送达状态，`/api/tasks` 提供任务列表。

## 首次配置

在项目目录执行：

```powershell
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local.ps1
npm run codex:check
node scripts/codex-check.mjs --live
node scripts/codex-doc-check.mjs
npm test
```

配置脚本复用本机已有的 Codex 登录文件，存入独立且限制当前用户和 SYSTEM 访问的 `data/codex-home/`，不复制个人插件配置。登录过期后需在该运行目录重新登录；不会自动从日常桌面配置同步账号变化。

独立运行目录禁止 shell、浏览器控制、电脑控制、插件和任意项目写入，保留自定义资料工具所需的 code-mode host。动态工具协议属于实验性接口，当前验证版本为 codex-cli 0.153.4，升级后应重新运行两个真实联调脚本。

飞书凭据继续使用现有 `.env`。接收附件需要应用的资源读取权限；文件发送使用飞书文件上传及机器人消息接口，具体权限需要在飞书后台生效。代码不会代替管理员发布飞书应用版本。

## 启动、停止和登录自启

```powershell
# 隐藏窗口启动，异常退出5秒后重启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local.ps1 -Start

# 当前 Windows 用户登录后自动启动
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1

# 停止后台服务
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-background.ps1
```

自启采用当前用户 Startup 快捷方式，无需管理员权限；这是“登录后自启”，不是无人登录时的系统服务。日志在 `data/service/`。默认看板为 http://127.0.0.1:3800/；若配置访问令牌，需要登录参数或认证头。关闭窗口、锁屏可以继续工作，休眠和断网会中断处理。

移除自启：在 Windows 的 `shell:startup` 目录删除“需求助手”快捷方式。停止服务不会移除自启设置。

## 配置

`.env` 支持：

```dotenv
ASSISTANT_BACKEND=codex
CODEX_BIN=本机codex.exe完整路径
REQ_CODEX_HOME=本项目data/codex-home完整路径
CODEX_MODEL=
CODEX_EFFORT=
CODEX_TIMEOUT_MS=900000
DOCUMENT_MAX_BYTES=31457280
```

模型和推理强度留空使用 Codex 默认值；不要直接把 DeepSeek 的参数移植过来。原 DeepSeek 配置保留，设置 `ASSISTANT_BACKEND=deepseek` 后重启即可切回；运行中失败不会自动改用另一后端重跑。

`config.json` 的 `projects.<项目ID>` 支持 `backend`、`contextDir`、`codex: { model, effort }`。contextDir 可以是项目根目录下的相对路径或绝对路径；专属角色提示词仍优先读取 `项目资料/<项目名称>/提示词.md`。只有配置明确登记的资料目录和会话附件会提供给模型工具。

## 处理边界

- 附件上传后自动概述，可以继续发消息要求比较、全文审阅或交付 Markdown。附件不自动变成已确认决策。
- Word 内嵌图片和复杂版式不做自动渲染；需另发图片或转换为 PDF。旧 `.doc/.xls` 请另存为 `.docx/.xlsx`。
- Excel 不重新计算公式，读取的是公式及文件里已缓存的结果；合并单元格、图表的视觉核对可先转 PDF。
- 扫描 PDF 由模型按页查看，不承诺逐字 OCR 准确率。全文审阅需要逐段覆盖，工具返回 next 游标；超大单行文本需要拆分。
- 本机部署仍会将选中的文字和图片发给模型。自动患者信息脱敏尚未实现，不应上传可识别患者原始资料。普通运行日志与审计数据也需要按项目要求管理。
- “同步文档”到外部系统的目标、身份规则和覆盖策略尚未配置，因此没有开放外部同步工具；仅开放新增本地 Markdown 交付并发送给当前聊天。
- 当前持久化为单机 JSON/JSONL，并未接入 MySQL；已有 schema.sql 保持用户原有修改。任务日志包含新的 tool_event 类型，数据库迁移需单独扩展。
- 任务和附件元数据没有自动清理策略，长期使用需定期备份与清理。

## 验证

`npm test` 不调用模型或飞书，覆盖文档、分页、图像渲染、隔离、持久化去重、取消和失败补发。两个 `--live` / `codex-doc-check` 脚本只使用合成测试资料，会实际消耗 Codex 用量；第二个验证 Excel、PDF图像和会话恢复。真实飞书附件上传与文件回传需在机器人聊天中验收。

## 用户信息与会话隔离

用户由飞书事件的 open_id 识别，姓名仅用于显示。每个用户在每个聊天、每个项目内都有独立历史、Codex会话、附件、任务查询和项目选择；同名用户也不会合并。`/whoami` 可查看自己的标识与资料获取状态。

基本资料通过飞书通讯录用户接口获取，仅保存ID、姓名、头像及查询状态，不保存手机号或邮箱。成功缓存24小时；接口失败缓存5分钟，避免反复请求。获取不到姓名不影响用户隔离。飞书管理员需要授权适用的通讯录基本信息权限及可见范围，并使应用版本生效。

管理员看板按用户与项目拆分会话，`/api/records` 支持 userId、chatId、platform、project 筛选，`/api/users` 显示已遇到用户的基本资料。该看板是管理员视图，不是普通用户门户。

旧日志和旧共享会话文件保留；新用户会话使用新命名空间，不自动注入旧群聊共享记忆。群聊里的回复仍会发到群里，成员可以看到群消息；上下文隔离不改变飞书消息的可见范围。

默认本机数据位置：

| 路径（位于项目 data 目录） | 内容 |
|---|---|
| records/records-YYYY-MM-DD.jsonl | 按天追加的聊天与工具审计日志，包含 userId/userName/chatId/project；默认90天保留，启动时清理过期日志 |
| users.json | 用户ID、姓名、头像、查询状态和更新时间 |
| memory/ | 按用户、聊天、项目隔离的近期对话记忆 |
| codex-sessions.json | 用户会话到Codex thread的映射 |
| codex-home/ | Codex自身的会话状态与独立登录环境 |
| tasks.json | 任务、最终结果和送达进度 |
| inbox/、attachments.json | 原始附件和按用户会话登记的附件索引 |
| outputs/ | 生成的交付文件 |

聊天审计日志采用JSONL文件，不是MySQL；日志在同一天的文件中按用户ID区分，并不为每位用户建立一个日志文件。
