-- DACCA 星型层（Postgres）DDL 草案 v0.1
-- 依据：《DACCA数据模型设计-医学实体表结构》《数据字典-值域代码表 v0.1/v0.2》
-- 状态：顾问建议（proposed），待专科确认医学实体表 9 节 6 项后升级。
-- 约定：
--   1) 枚举一律 VARCHAR + 值域字典校验（不用 PG ENUM——字典只加不删，VARCHAR 免迁移）；
--      值域见数据字典，代码列存编码、中文值由应用层展示。
--   2) 外键暂不建物理约束（多中心批量写入场景），以注释标注逻辑关联；主键确定性生成。
--   3) 通用治理字段：source / grade_source / source_doc_type / ai_extraction_audit(JSONB) /
--      created_at / updated_at，随各事实表统一携带。
--   4) 本草案不包含第 8 节「不建的字段」清单中的任何派生列。

-- ── 维度表 ──────────────────────────────────────────────────────────

CREATE TABLE dim_patient (
  patient_id            VARCHAR(64) PRIMARY KEY,          -- UUID5/确定性哈希，不含明文身份
  id_card_hash          VARCHAR(64),                      -- 受控：明文需 raw 权限
  hospital_no_hash      VARCHAR(64),
  gender                VARCHAR(8),                       -- 字典：1 男 2 女 9 未知
  birth_date            DATE,
  birth_date_precision  VARCHAR(8),                       -- day/month/year
  nationality           VARCHAR(32),
  education             VARCHAR(32),
  occupation            VARCHAR(64),
  urban_rural           VARCHAR(8),                       -- 公平性分层轴
  residence_region      VARCHAR(64),
  marital_status        VARCHAR(8),
  insurance_type        VARCHAR(8),                       -- 下一阶段启用，本轮建列留空
  insured_region        VARCHAR(64),
  blood_type            VARCHAR(8),
  family_history_flag   BOOLEAN,
  vital_status          VARCHAR(8),                       -- 快照：由随访事件自动刷新，禁人工直改
  death_date            DATE,
  death_date_precision  VARCHAR(8),
  death_cause           VARCHAR(8),                       -- E1 肿瘤相关 E2 治疗相关 E3 其他
  last_followup_date    DATE,                             -- 由随访事件推导刷新（生存分析删失用）
  data_completeness_score NUMERIC(5,2),                   -- 规则计算
  governance_status     VARCHAR(16),
  ai_training_permitted BOOLEAN,
  authorized_scope      VARCHAR(32),
  vectorization_status  VARCHAR(16),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dim_tumor (
  tumor_id              VARCHAR(64) PRIMARY KEY,
  patient_id            VARCHAR(64) NOT NULL,             -- → dim_patient
  tumor_seq             SMALLINT NOT NULL,                -- 第几个原发灶
  primary_site          VARCHAR(8),                       -- 字典：盲肠/升结肠/…/直肠
  distance_from_anal_verge_cm NUMERIC(5,1),               -- 保肛决策核心变量
  laterality            VARCHAR(8),                       -- 左半/右半
  diagnosis_date        DATE,
  diagnosis_date_precision VARCHAR(8),
  diagnosis_basis       VARCHAR(8),
  histology_type        VARCHAR(8),
  clinical_t            VARCHAR(8),
  clinical_n            VARCHAR(8),
  clinical_m            VARCHAR(8),
  clinical_stage        VARCHAR(16),
  stage_system_version  VARCHAR(8),                       -- AJCC7/8 必记
  synchronous_flag      BOOLEAN,                          -- 派生：tumor_seq+诊断间隔，禁直录
  tumor_status          VARCHAR(8),                       -- 派生：由事件推导
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dim_center (
  center_id             VARCHAR(32) PRIMARY KEY,
  center_name           VARCHAR(128) NOT NULL,
  center_level          VARCHAR(16),
  region                VARCHAR(64)
);

-- ── 事件主干表（所有临床事件先在此登记）─────────────────────────────

CREATE TABLE fact_clinical_event (
  event_id              VARCHAR(64) PRIMARY KEY,          -- patient_id+event_date+event_type+seq 确定性生成
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),                      -- 患者级事件为空
  event_type            VARCHAR(24) NOT NULL,             -- surgery/pathology/molecular/…/death
  event_date            DATE NOT NULL,
  event_date_precision  VARCHAR(8) NOT NULL DEFAULT 'day',-- day/month/year：历史数据常只有年月
  parent_event_id       VARCHAR(64),                      -- 并发症→手术；AE→用药；病理→手术
  admission_no          VARCHAR(64),
  source_doc_type       VARCHAR(32),                      -- 血缘：来自哪类文书，不参与结构
  source                VARCHAR(16) NOT NULL,             -- HIS/Excel/人工/研究组表
  grade_source          VARCHAR(16),                      -- 临床专家/人工录入/系统推导
  ai_extraction_audit   JSONB,                            -- AI 抽取审计：字段/置信度/原文定位
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 核心事实表（可立即开工模块）────────────────────────────────────

CREATE TABLE fact_surgery (
  surgery_id            VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,             -- → fact_clinical_event
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  surgery_no            VARCHAR(64),                      -- 手术流水号
  surgery_date          DATE,
  surgery_start_time    TIME,
  surgery_end_time      TIME,
  duration_min          INTEGER,
  procedure_type        VARCHAR(8),                       -- 字典：LAR/ISR-A/B/C/APR/…
  procedure_name        VARCHAR(128),
  surgical_intent       VARCHAR(8),                       -- 根治/姑息/减瘤/急诊
  approach              VARCHAR(8),                       -- 开放/腹腔镜/机器人/…
  conversion_to_open    BOOLEAN,
  conversion_reason     VARCHAR(256),
  sphincter_preservation BOOLEAN,
  anastomosis_type      VARCHAR(8),
  anastomosis_distance_cm NUMERIC(5,1),
  anastomosis_quality   VARCHAR(8),
  stoma_created         BOOLEAN,
  stoma_type            VARCHAR(8),
  stoma_reason          VARCHAR(8),
  stoma_closure_date    DATE,                             -- 造口状态派生，不建列
  blood_loss_ml         INTEGER,
  transfusion_flag      BOOLEAN,
  transfusion_volume    NUMERIC(8,2),
  lymph_node_dissection_extent VARCHAR(4),                -- D1/D2/D3
  combined_resection    VARCHAR(128),
  icg_navigation        BOOLEAN,
  nos_specimen_extraction BOOLEAN,
  platform_brand        VARCHAR(64),
  surgeon_id            VARCHAR(64),                      -- 哈希，受控
  assistant_ids         JSONB,
  center_id             VARCHAR(32),
  r_status              VARCHAR(4),                       -- R0/R1/R2
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_pathology (
  pathology_id          VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  parent_event_id       VARCHAR(64),                      -- 对应手术
  specimen_type         VARCHAR(8),
  specimen_date         DATE,
  report_date           DATE,
  pathology_no          VARCHAR(64),
  histology_type        VARCHAR(8),
  differentiation_grade VARCHAR(8),
  mucinous_component    BOOLEAN,
  signet_ring_component BOOLEAN,
  invasion_depth        VARCHAR(16),
  lymphovascular_invasion BOOLEAN,
  perineural_invasion   BOOLEAN,
  tumor_deposits        SMALLINT,
  ln_examined           SMALLINT,                         -- ≥12 达标为派生质控指标
  ln_positive           SMALLINT,
  proximal_margin       VARCHAR(16),
  distal_margin         VARCHAR(16),
  crm_status            VARCHAR(8),                       -- 阳性(≤1mm)/阴性
  crm_distance_mm       NUMERIC(6,2),
  pathologic_t          VARCHAR(8),
  pathologic_n          VARCHAR(8),
  pathologic_m          VARCHAR(8),
  pathologic_stage      VARCHAR(16),
  stage_system_version  VARCHAR(8),
  yptnm_flag            BOOLEAN,                          -- 新辅助后分期标记
  trg_grade             VARCHAR(4),                       -- TRG0-3；pCR 由 TRG0 推导不建列
  tumor_size_cm         NUMERIC(6,2),
  gross_type            VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_molecular_test (
  molecular_id          VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  test_item             VARCHAR(8),                       -- KRAS/NRAS/BRAF/… 一个项目一行
  test_date             DATE,
  report_date           DATE,
  specimen_type         VARCHAR(8),                       -- 原发灶/转移灶/ctDNA 必须区分
  specimen_source_event_id VARCHAR(64),
  test_method           VARCHAR(8),
  result_qualitative    VARCHAR(8),
  mutation_site         VARCHAR(128),
  result_quantitative   NUMERIC(10,3),
  result_unit           VARCHAR(16),
  mmr_protein_detail    JSONB,                            -- MLH1/MSH2/MSH6/PMS2 分蛋白记录
  testing_lab           VARCHAR(128),
  platform              VARCHAR(64),
  reagent               VARCHAR(64),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_medication (
  medication_id         VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  regimen_id            VARCHAR(64),                      -- 方案组标识：同一方案多药共享
  regimen_name          VARCHAR(64),
  drug_generic_name     VARCHAR(128),
  drug_trade_name       VARCHAR(128),
  drug_category         VARCHAR(8),                       -- 化疗/靶向/免疫/内分泌/支持
  treatment_intent      VARCHAR(8),
  treatment_line        VARCHAR(8),
  start_date            DATE,
  end_date              DATE,
  cycle_number          INTEGER,
  planned_cycles        INTEGER,
  actual_cycles         INTEGER,
  dose                  NUMERIC(10,3),
  dose_unit             VARCHAR(8),
  dose_intensity        NUMERIC(10,3),
  route                 VARCHAR(8),
  frequency             VARCHAR(64),
  dose_adjusted         BOOLEAN,
  dose_adjust_reason    VARCHAR(8),
  discontinuation_reason VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_complication (
  complication_id       VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  parent_event_id       VARCHAR(64),                      -- 对应手术
  complication_type     VARCHAR(8),                       -- 吻合口漏/出血/…（标准术语）
  onset_date            DATE,
  days_after_surgery    INTEGER,                          -- 派生
  intervention_required BOOLEAN,
  intervention_measures JSONB,                            -- 多选：药物/输血/TPN/内镜/介入/再手术/ICU
  general_anesthesia_required BOOLEAN,                    -- CD IIIa/IIIb 分界依据
  organ_failure         VARCHAR(8),                       -- 无/单/多器官（IVa/IVb 分界）
  icu_admission         BOOLEAN,
  icu_days              INTEGER,
  outcome               VARCHAR(8),
  cd_grade              VARCHAR(8),                       -- 优先由干预事实推导
  cd_grade_source       VARCHAR(8),                       -- 自动推导/人工补充/录入端直给
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_adverse_event (
  ae_id                 VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  parent_event_id       VARCHAR(64),                      -- 对应用药/放疗
  ae_term               VARCHAR(128),                     -- 对接 CTCAE/MedDRA
  meddra_code           VARCHAR(16),
  ctcae_grade           VARCHAR(4),
  ctcae_version         VARCHAR(8),                       -- 版本必记
  onset_date            DATE,
  resolution_date       DATE,
  serious_flag          BOOLEAN,
  serious_criteria      VARCHAR(8),
  causality             VARCHAR(8),
  suspected_drug_id     VARCHAR(64),                      -- → fact_medication
  action_taken          VARCHAR(8),
  outcome               VARCHAR(8),
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_response_assessment (
  assessment_id         VARCHAR(64) PRIMARY KEY,
  event_id              VARCHAR(64) NOT NULL,
  patient_id            VARCHAR(64) NOT NULL,
  tumor_id              VARCHAR(64),
  assessment_date       DATE,
  assessment_context    VARCHAR(8),
  related_regimen_id    VARCHAR(64),
  criteria              VARCHAR(8),                       -- RECIST 1.1 / iRECIST
  criteria_version      VARCHAR(8),
  target_lesion_sum_mm  NUMERIC(8,1),
  best_response         VARCHAR(4),                       -- CR/PR/SD/PD/NE
  progression_flag      BOOLEAN,
  progression_date      DATE,                             -- PFS 终点起算关键字段
  imaging_no_residual   BOOLEAN,                          -- cCR 三项原子事实
  endoscopy_no_residual BOOLEAN,
  dre_no_residual       BOOLEAN,
  imaging_date          DATE,
  endoscopy_date        DATE,
  dre_date              DATE,
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fact_comorbidity (
  comorbidity_id        VARCHAR(64) PRIMARY KEY,
  patient_id            VARCHAR(64) NOT NULL,             -- 挂患者，不挂肿瘤
  condition_name        VARCHAR(64),
  icd10_code            VARCHAR(16),
  diagnosis_date        DATE,
  status                VARCHAR(8),                       -- 现患/既往/已治愈
  severity              VARCHAR(8),
  charlson_weight       SMALLINT,                         -- Charlson 总分由权重求和推导
  source                VARCHAR(16),
  grade_source          VARCHAR(16),
  source_doc_type       VARCHAR(32),
  ai_extraction_audit   JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 索引建议（初版）─────────────────────────────────────────────────
CREATE INDEX idx_event_patient_date ON fact_clinical_event (patient_id, event_date);
CREATE INDEX idx_event_parent       ON fact_clinical_event (parent_event_id);
CREATE INDEX idx_surgery_patient    ON fact_surgery (patient_id, surgery_date);
CREATE INDEX idx_medication_regimen ON fact_medication (regimen_id);
CREATE INDEX idx_ae_parent          ON fact_adverse_event (parent_event_id);
