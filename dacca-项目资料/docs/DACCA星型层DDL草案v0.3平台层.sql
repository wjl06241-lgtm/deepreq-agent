-- DACCA 星型层 DDL 草案 v0.3 · 平台层（接入/治理/规则/事件溯源/集市/系统）
-- 依据：主文档 5.1 表分组、6A.2 field_registry、6.2 规则注册表、7 接入层、1.3 数据护照
-- 状态：顾问建议（proposed）。表命名对账项（台账第五节）未拍板前，事实表沿用医学实体表命名。

-- ── 接入层 ──────────────────────────────────────────────────────────

CREATE TABLE source_batch_registry (
  batch_id              VARCHAR(64) PRIMARY KEY,          -- 批次号 + 文件哈希确定性生成
  source_name           VARCHAR(128) NOT NULL,
  file_name             VARCHAR(256),
  file_hash             VARCHAR(64) NOT NULL,
  source_system         VARCHAR(32) NOT NULL,             -- HIS/Excel/人工录入/研究组表
  row_count             INTEGER,
  registered_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                VARCHAR(16) NOT NULL DEFAULT 'registered'  -- registered/loading/loaded/quarantined
);

CREATE TABLE field_mapping_registry (
  mapping_id            BIGSERIAL PRIMARY KEY,
  batch_id              VARCHAR(64) NOT NULL,
  source_field          VARCHAR(128) NOT NULL,            -- 源文件列名
  target_table          VARCHAR(64),                      -- 目标事实表
  target_column         VARCHAR(64),                      -- 目标列
  field_id              VARCHAR(64),                      -- → field_registry
  mapping_rule          TEXT,
  rule_version          VARCHAR(16),
  UNIQUE (batch_id, source_field)
);

CREATE TABLE value_domain_registry (
  domain_id             VARCHAR(64) PRIMARY KEY,
  domain_name_cn        VARCHAR(128) NOT NULL,
  code                  VARCHAR(16) NOT NULL,             -- 枚举编码
  value_cn              VARCHAR(128) NOT NULL,            -- 中文值
  sort_order            INTEGER,
  status                VARCHAR(16) NOT NULL DEFAULT 'active',  -- active/deprecated（只能加不能删）
  UNIQUE (domain_id, code)
);

CREATE TABLE identity_linkage_map (
  candidate_id          BIGSERIAL PRIMARY KEY,
  match_type            VARCHAR(16) NOT NULL,             -- auto/candidate/forbidden
  match_score           NUMERIC(5,4),
  evidence              JSONB,
  patient_a_hash        VARCHAR(64),
  patient_b_hash        VARCHAR(64),
  review_status         VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending/merged/rejected
  reviewed_by           VARCHAR(64),
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 红线 13.2-4：代码中不得存在「得分超阈值即自动合并」分支；合并必须可逆。

-- ── 治理层 ──────────────────────────────────────────────────────────

CREATE TABLE dq_rule_registry (
  dq_rule_id            BIGSERIAL PRIMARY KEY,
  rule_name             VARCHAR(128) NOT NULL,
  rule_expression       TEXT NOT NULL,                    -- 可配置表达式
  severity              VARCHAR(8) NOT NULL,              -- hard_block/warn/pass
  target_table          VARCHAR(64),
  target_column         VARCHAR(64),
  is_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  rule_version          VARCHAR(16) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dq_exception_log (
  exception_id          BIGSERIAL PRIMARY KEY,
  batch_id              VARCHAR(64),
  source_record_id      VARCHAR(128),
  dq_rule_id            BIGINT,
  severity              VARCHAR(8),
  message               TEXT,
  quarantine_flag       BOOLEAN NOT NULL DEFAULT FALSE,   -- 硬阻断进隔离区
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  audit_id              BIGSERIAL PRIMARY KEY,
  actor_id              VARCHAR(64),
  action                VARCHAR(32) NOT NULL,             -- PATCH/APPROVE/MERGE/EXPORT/…
  target_table          VARCHAR(64),
  target_id             VARCHAR(64),
  before_value          JSONB,
  after_value           JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_passport (
  passport_id           VARCHAR(64) PRIMARY KEY,
  batch_id              VARCHAR(64),
  patient_id            VARCHAR(64),                      -- 批次与患者双层控制
  source_info           JSONB,
  authorization         JSONB,                            -- 授权用途/范围
  masking_level         VARCHAR(16),                      -- 脱敏四级（10.1）
  status                VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meta_data_governance (
  governance_id         BIGSERIAL PRIMARY KEY,
  patient_id            VARCHAR(64),
  completeness_score    NUMERIC(5,2),
  governance_status     VARCHAR(16),                      -- clean/needs_review/quarantined
  task_queue_id         VARCHAR(64),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 规则层 ──────────────────────────────────────────────────────────

CREATE TABLE rule_version_registry (
  rule_version_id       BIGSERIAL PRIMARY KEY,
  rule_name             VARCHAR(128) NOT NULL,
  version               VARCHAR(16) NOT NULL,
  params                JSONB NOT NULL,                   -- 阈值/锚点参数（如 months=6）
  effective_from        TIMESTAMPTZ,
  superseded_by         BIGINT,
  UNIQUE (rule_name, version)
);

CREATE TABLE derivation_rule_registry (
  derivation_rule_id    BIGSERIAL PRIMARY KEY,
  rule_version_id       BIGINT NOT NULL,
  output_label          VARCHAR(64),                      -- 派生标签（异时性/CD/pCR/cCR/…）
  description           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 字段元数据注册表（6A.2：全库字段唯一说明书）────────────────────

CREATE TABLE field_registry (
  field_id              VARCHAR(64) PRIMARY KEY,
  table_name            VARCHAR(64) NOT NULL,
  column_name           VARCHAR(64) NOT NULL,
  field_name_cn         VARCHAR(128) NOT NULL,
  definition            TEXT,                             -- 医学定义（AI 语义匹配主依据）
  synonyms              JSONB,                            -- 同义词/别名
  data_type             VARCHAR(32),
  value_domain_id       VARCHAR(64),                      -- → value_domain_registry
  unit                  VARCHAR(32),
  is_required           BOOLEAN NOT NULL DEFAULT FALSE,
  is_derived            BOOLEAN NOT NULL DEFAULT FALSE,   -- 派生字段禁人工录入
  derivation_rule_id    BIGINT,
  authority_source      VARCHAR(8),                       -- system/expert（12.1 仲裁）
  ui_widget             VARCHAR(16),
  ui_group              VARCHAR(64),
  ui_order              INTEGER,
  ai_extractable        BOOLEAN NOT NULL DEFAULT FALSE,
  ai_hint               TEXT,
  participates_in_score BOOLEAN NOT NULL DEFAULT TRUE,
  masking_level         VARCHAR(16),
  exportable            BOOLEAN NOT NULL DEFAULT FALSE,
  status                VARCHAR(16) NOT NULL DEFAULT 'draft',  -- draft/active/deprecated
  version               VARCHAR(16),
  created_by            VARCHAR(64),
  approved_by           VARCHAR(64),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 事件溯源 sidecar ────────────────────────────────────────────────

CREATE TABLE event_store (
  event_store_id        BIGSERIAL PRIMARY KEY,
  patient_id            VARCHAR(64),
  event_type            VARCHAR(32),
  event_date            DATE,
  payload               JSONB NOT NULL,                   -- 复杂上下文事件包
  source_record_id      VARCHAR(128),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 集市与系统（示例）───────────────────────────────────────────────

CREATE TABLE mart_patient_summary (
  patient_id            VARCHAR(64) PRIMARY KEY,          -- 由规则引擎重建，可随时重算
  summary_payload       JSONB,
  derived_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sys_users (
  user_id               BIGSERIAL PRIMARY KEY,
  username              VARCHAR(64) NOT NULL UNIQUE,
  role_id               BIGINT,
  expires_at            TIMESTAMPTZ,                      -- 13.2-11 权限过期机制
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sys_roles (
  role_id               BIGSERIAL PRIMARY KEY,
  role_name             VARCHAR(64) NOT NULL UNIQUE,
  permissions           JSONB
);

-- ── v0.1/v0.2 事实表通用列回填（主文档 5.3）─────────────────────────
-- 对既有事实表执行（示例为 fact_surgery，其余表同理）：
--   ALTER TABLE fact_surgery ADD COLUMN source_record_id VARCHAR(128);
--   ALTER TABLE fact_surgery ADD COLUMN raw_value JSONB;
--   ALTER TABLE fact_surgery ADD COLUMN cleaned_value JSONB;
--   ALTER TABLE fact_surgery ADD COLUMN mapping_rule_id BIGINT;
--   ALTER TABLE fact_surgery ADD COLUMN rule_version VARCHAR(16);
--   ALTER TABLE fact_surgery ADD COLUMN data_status VARCHAR(16);  -- 实测/推断/预测/人工修正/AI提取
--   ALTER TABLE fact_surgery ADD COLUMN confidence NUMERIC(5,4);
--   ALTER TABLE fact_surgery ADD COLUMN extracted_by_ai BOOLEAN DEFAULT FALSE;
--   ALTER TABLE fact_surgery ADD COLUMN review_status VARCHAR(16);
--   ALTER TABLE fact_surgery ADD COLUMN reviewed_by VARCHAR(64);
--   ALTER TABLE fact_surgery ADD COLUMN reviewed_at TIMESTAMPTZ;
--   ALTER TABLE fact_surgery ADD COLUMN source_batch_id VARCHAR(64);
