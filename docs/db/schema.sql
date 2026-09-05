-- 需求助手 · 数据库表结构（MySQL 8.0，utf8mb4）
-- 设计说明见 docs/数据库设计.md
-- 与现有 JSONL 记录字段一一对应（src/store.js 顶部注释），历史数据可一键导入。

-- ── 1. 聊天记录（核心表：所有聊天内容全量入库）─────────────────────────
CREATE TABLE IF NOT EXISTS chat_records (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  record_uuid CHAR(36)     NOT NULL COMMENT '记录唯一 id（对应 JSONL 的 id）',
  ts          BIGINT       NOT NULL COMMENT '事件时间戳（毫秒）',
  kind        ENUM('user_message','assistant_message','error','unanswered','ops_note')
                           NOT NULL COMMENT '记录类型',
  platform    VARCHAR(16)  NOT NULL DEFAULT 'feishu' COMMENT '渠道',
  chat_id     VARCHAR(64)  NOT NULL COMMENT '飞书聊天 id（oc_…）',
  user_id     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '发送者 open_id（ou_…）',
  user_name   VARCHAR(128) NOT NULL DEFAULT '' COMMENT '发送者名称',
  project_id  VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '项目 id（空 = 默认会话）',
  text        MEDIUMTEXT   NULL COMMENT '用户消息 / 助手回复正文',
  status      VARCHAR(32)  NULL COMMENT '回合状态（error / aborted / …，冗余便于查询）',
  error       VARCHAR(2048) NULL COMMENT '错误信息（kind=error 时）',
  usage       JSON         NULL COMMENT 'token 用量（prompt/completion/reasoning）',
  ref_id      CHAR(36)     NULL COMMENT '关联：unanswered→问题记录；ops_note→问题记录',
  action      VARCHAR(32)  NULL COMMENT '运营动作（ops_note 时，如 resolved）',
  note        VARCHAR(512) NULL COMMENT '运营备注',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '入库时间',
  UNIQUE KEY uk_record_uuid (record_uuid),
  KEY idx_chat_ts    (chat_id, ts),
  KEY idx_project_ts (project_id, ts),
  KEY idx_kind_ts    (kind, ts),
  KEY idx_ref        (ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天记录';

-- ── 2. 项目（/project new 创建；模型/提示词覆盖来自 config.json 同步）──────
CREATE TABLE IF NOT EXISTS projects (
  id          VARCHAR(16)  PRIMARY KEY COMMENT '项目 id（p+哈希10位）',
  name        VARCHAR(60)  NOT NULL COMMENT '项目名称',
  created_at  BIGINT       NOT NULL COMMENT '创建时间戳（毫秒）',
  model       JSON         NULL COMMENT '模型覆盖 {model, reasoningEffort, maxTokens}',
  prompt      MEDIUMTEXT   NULL COMMENT '项目提示词覆盖',
  context_dir VARCHAR(255) NOT NULL DEFAULT '' COMMENT '项目上下文目录（空=默认）',
  UNIQUE KEY uk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目';

-- ── 3. 聊天当前激活项目（data/projects.json 的 active 映射）────────────────
CREATE TABLE IF NOT EXISTS chat_project_active (
  chat_id    VARCHAR(64) PRIMARY KEY COMMENT '飞书聊天 id',
  project_id VARCHAR(16) NOT NULL COMMENT '当前激活项目 id',
  updated_at BIGINT      NOT NULL COMMENT '切换时间戳（毫秒）',
  KEY idx_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='聊天当前激活项目';

-- ── 4. 问题回答状态（未回答检测的运行态：告警/处理标记）───────────────────
CREATE TABLE IF NOT EXISTS question_status (
  question_id      CHAR(36)     PRIMARY KEY COMMENT '对应 chat_records.record_uuid（kind=user_message）',
  chat_id          VARCHAR(64)  NOT NULL COMMENT '聊天 id',
  project_id       VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '项目 id',
  user_id          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '提问者',
  first_alerted_at BIGINT       NULL COMMENT '首次判定未回答并告警的时间（毫秒）',
  resolved_at      BIGINT       NULL COMMENT '运营标记已处理时间（毫秒，NULL=待处理）',
  resolved_note    VARCHAR(512) NOT NULL DEFAULT '' COMMENT '处理备注',
  KEY idx_open  (first_alerted_at, resolved_at),
  KEY idx_chat  (chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='问题回答状态';

-- ── 5. 告警记录（审计：何时给谁发了什么告警）──────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts         BIGINT       NOT NULL COMMENT '告警时间戳（毫秒）',
  kind       ENUM('unanswered','error') NOT NULL COMMENT '告警类型',
  chat_id    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '来源聊天',
  project_id VARCHAR(16)  NOT NULL DEFAULT '' COMMENT '来源项目',
  target     VARCHAR(64)  NOT NULL COMMENT '告警接收人（open_id）',
  text       VARCHAR(1024) NOT NULL DEFAULT '' COMMENT '告警文案摘要',
  KEY idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='告警记录';
