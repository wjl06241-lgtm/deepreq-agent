# 历史对话上下文目录

把「以前的那段很长聊天记录」导出后放到本目录的 raw\ 子目录，然后运行加工脚本：

    node scripts\build-context.mjs            # 生成压缩版项目上下文 + 全文分块
    node scripts\build-context.mjs --summarize   # 额外调用 DeepSeek 对每块做要点摘要（需 DEEPSEEK_API_KEY）

## 支持的原始文件格式

| 格式 | 要求 |
|---|---|
| `.jsonl` | 每行 JSON：`{"role":"user"/"assistant","content":"...","ts":...}` 或 `{"speaker":"张三","text":"...","time":...}` |
| `.csv` | 表头包含 时间/发言人/内容 三列（英文 time/speaker/text 亦可，列名可任意顺序） |
| `.txt` / `.md` | 每行一条，支持两种常见形态：`【张三】内容…`、`张三: 内容…`（同一人连续多行自动合并） |

飞书导出通常是 xlsx：请先在 Excel/WPS 里「另存为 CSV UTF-8」再放入 raw\。

## 脚本输出

| 文件 | 说明 |
|---|---|
| `..\AGENTS.md`、`..\AGENTS.local.md` | 压缩版项目上下文（统计 + 参与者 + FAQ + 最近对话摘录 + 分块索引） |
| `context\项目上下文.md` | 同上（副本，方便直接查看） |
| `context\chunks\chunk-001.md …` | 全文按 200 条/块分块（供后续检索/RAG 使用） |
| `context\stats.json` | 解析统计（条数、时间范围、参与者） |

## 接入提示词（自动，无需手动）

需求助手服务会自动把 `..\AGENTS.md` 追加进系统提示词（约 30KB 上限）；
每项目可在 `..\projects\<项目id>\AGENTS.local.md` 维护该项目的专属上下文（同样自动注入）。
生成后无需重启：每次回答都会重新读取最新内容。
