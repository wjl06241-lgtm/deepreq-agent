-- DACCA 星型层 DDL 草案 v0.2 补充（剩余事实表 + 医患沟通三层）
-- 配合 v0.1 使用；约定同 v0.1。
-- 说明：v0.1 各表终版需统一补 evidence_level 列（objective_measured / clinician_assessed /
-- patient_reported，医患对话抽取事实一律 patient_reported——见医学实体表 6A.6）。

-- ── 治疗类事实表（补全）────────────────────────────────────────────

CREATE TABLE fact_radiotherapy (
  radiotherapy_id       VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  rt_intent             VARCHAR(8),
  rt_technique          VARCHAR(8),
  target_site           VARCHAR(8),
  total_dose_gy         NUMERIC(6,2),
  fraction_dose_gy      NUMERIC(6,2),
  fraction_count        INTEGER,
  start_date            DATE,
  end_date              DATE,
  concurrent_chemo_flag BOOLEAN,
  concurrent_regimen_id VARCHAR(64),
  completion_status     VARCHAR(8),
  interruption_reason   VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_recurrence_metastasis (
  recurrence_id         VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  lesion_type           VARCHAR(8),                       -- 局部复发/区域淋巴结/远处转移
  site                  VARCHAR(8),                       -- 肝/肺/腹膜/骨/脑/远处淋巴结…
  site_detail           VARCHAR(128),
  detection_date        DATE,                             -- 首次检出日：异时性推导关键原子事实
  detection_date_precision VARCHAR(8),
  detection_method      VARCHAR(8),
  pathology_confirmed   BOOLEAN,
  lesion_count          SMALLINT,
  max_diameter_mm       NUMERIC(8,1),
  resectable_assessment VARCHAR(16),
  treatment_received    VARCHAR(256),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_followup (
  followup_id           VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  followup_date         DATE,
  followup_round        SMALLINT,
  followup_method       VARCHAR(8),
  vital_status          VARCHAR(8),                       -- 事实（当时观察）；患者表为快照
  disease_status        VARCHAR(8),
  ecog_ps               VARCHAR(4),                       -- 随时间变，故在事件表
  body_weight           NUMERIC(6,2),
  bmi                   NUMERIC(5,2),
  readmission_flag      BOOLEAN,
  admission_date        DATE,
  discharge_date        DATE,
  lost_to_followup_flag BOOLEAN,
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_lab_test (
  lab_id                VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  test_item             VARCHAR(8),                       -- 长表：一项一行
  test_date             DATE,
  result_value          NUMERIC(12,3),
  result_unit           VARCHAR(16),
  reference_range       VARCHAR(32),
  abnormal_flag         VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_imaging (
  imaging_id            VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  modality              VARCHAR(8),
  exam_date             DATE,
  body_part             VARCHAR(8),
  finding_summary       TEXT,
  impression            TEXT,
  structured_findings   JSONB,
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_functional_assessment (
  functional_id         VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  surgery_no            VARCHAR(64),                      -- 关联手术
  scale_type            VARCHAR(8),                       -- LARS/QLQ-C30/CR29/Wexner
  scale_version         VARCHAR(16),
  planned_timepoint     VARCHAR(8),                       -- 3M/6M/9M/12M/18M/24M/计划外
  assessment_date       DATE,
  days_after_surgery    INTEGER,                          -- 派生
  item_responses        JSONB,                            -- 条目原始作答（只存这一层）
  assessment_mode       VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  evidence_level        VARCHAR(24),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 医患沟通三层（6A：原文严于其他表的访问控制）─────────────────────

CREATE TABLE dim_communication_session (
  session_id            UUID PRIMARY KEY,
  patient_id            VARCHAR(64) NOT NULL,
  admission_id          UUID,
  related_event_id      VARCHAR(64),
  channel               VARCHAR(8),                       -- 微信/APP/电话/门诊问答/短信
  session_start         TIMESTAMPTZ,
  session_end           TIMESTAMPTZ,
  message_count         INTEGER,
  participant_roles     JSONB,
  days_from_surgery     INTEGER,                          -- 派生
  treatment_phase       VARCHAR(16),                      -- 派生：术前/围手术期/辅助治疗期/随访期
  extraction_status     VARCHAR(16),                      -- 未抽取/已抽取/人工复核完成
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_communication_message (
  message_id            UUID PRIMARY KEY,
  session_id            UUID NOT NULL,                    -- → dim_communication_session
  sender_role           VARCHAR(8),                       -- 患者/家属/医生/护士
  sent_at               TIMESTAMPTZ,
  content_type          VARCHAR(8),                       -- 文字/图片/语音转写/文件
  content_text          TEXT,
  deidentified          BOOLEAN,
  contains_sensitive    BOOLEAN,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 访问控制（应用层强制，非 DDL 范畴）：主诊医生(本人患者)可读原文；治理专员抽取复核期可读；
-- 科研人员对原文完全不可见，仅用第三层抽取结果；原文一律不出库。

-- ── 索引建议（补充）─────────────────────────────────────────────────
CREATE INDEX idx_recurrence_patient ON fact_recurrence_metastasis (patient_id, detection_date);
CREATE INDEX idx_followup_patient   ON fact_followup (patient_id, followup_date);
CREATE INDEX idx_lab_patient_item   ON fact_lab_test (patient_id, test_item, test_date);
CREATE INDEX idx_msg_session        ON fact_communication_message (session_id, sent_at);
