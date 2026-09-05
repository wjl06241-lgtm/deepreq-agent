# DACCA 数据模型设计 · 医学实体表结构

版本：v1.0
日期：2026-08-12
面向对象：工程团队 Leader、数据库负责人、医疗团队字段审核人
文档定位：星型事实库的实体建模与表结构规格，工程建库直接依据
配套：《系统开发技术方案》第 5 章（表分组总览）、第 6C.11 节（文书分类 ≠ 表分类）

---

## 1. 建模三原则

> **前置阅读**：本章三条原则的来源与判定方法见《系统开发技术方案》**第 2A 章「本体论」**。
> 该章解释了"为什么表结构必须长成本文档这个样子"，并给出遇到设计取舍时的判断标准（某物是否属于本体、字段该放哪张表、该建列还是走规则）。**建库前工程团队须先读该章。**

| 原则 | 含义 | 违反的后果 |
|---|---|---|
| **实体驱动** | 表对应医学上真实存在的实体与事件，不对应文书格式、不对应 Excel 表头 | 换数据源即失效；同一事实被劈散 |
| **事实与结论分离** | 表只存"观察到什么"；"这意味着什么"由规则引擎产出 | 口径变更需重录数据，历史不可复现 |
| **时间轴完整** | 每个事件都有明确时间锚点，可还原患者完整病程 | 无法做时序分析、无法判断因果顺序 |

---

## 2. 三层实体骨架

这是本模型与常见"患者-事件"两层设计的核心差别。

```
第一层  dim_patient          这个人是谁          （人口学、分层轴、身份）
   │
   │  1 : N
   ↓
第二层  dim_tumor            这个人得了什么瘤    （部位、初诊分期、原发/多原发）
   │
   │  1 : N
   ↓
第三层  fact_* 事件表         围绕这个瘤发生了什么（诊断/治疗/检查/结局/评估/随访）
```

### 2.1 为什么必须有「肿瘤」这一层

**同时性多原发结直肠癌并不罕见**（文献报道约 2-5%），此外还有异时性多原发、以及结肠癌合并直肠癌的情况。

若跳过这一层、把肿瘤属性直接挂患者：

| 问题 | 表现 |
|---|---|
| 分期无处安放 | 一个患者两个原发灶，各自 TNM 不同，患者表只能存一个 |
| 手术归属不清 | 两次手术分别针对哪个病灶，无法表达 |
| 复发判定错误 | 第二个原发被误判为第一个的复发 |
| 队列筛选污染 | 按"直肠癌"筛人时，把只有结肠原发的患者也筛进来 |

**设计决定**：肿瘤是独立实体，`tumor_id` 是仅次于 `patient_id` 的第二锚点。绝大多数患者只有一条 tumor 记录，但结构上支持多条。

### 2.2 事件挂在哪一层

不是所有事件都挂肿瘤：

| 事件类型 | 挂载层 | 理由 |
|---|---|---|
| 手术、病理、分子、疗效评估、复发转移 | **tumor** | 明确针对某个病灶 |
| 用药、放疗 | **tumor** | 针对特定肿瘤的治疗 |
| 并发症、不良事件 | **父事件**（手术/用药） | 是治疗的后果，不是肿瘤的属性 |
| 合并症、随访、功能评价、生存结局 | **patient** | 属于人，不属于某个瘤 |

---

## 3. 事件主干表：fact_clinical_event

### 3.1 设计意图

15 张事件表若各自独立，做"该患者按时间发生了什么"需要 UNION 十几张表。因此设一张**事件主干（event backbone）**：所有事件先在此登记，取得统一 `event_id` 与时间轴位置，明细再落到各专用表。

```
fact_clinical_event （主干：每个事件一行，登记"何时发生了何类事件"）
   ├─ fact_surgery              （手术明细）
   ├─ fact_pathology            （病理明细）
   ├─ fact_molecular_test       （分子检测明细）
   ├─ fact_medication           （用药明细）
   ├─ fact_radiotherapy         （放疗明细）
   ├─ fact_complication         （并发症明细）
   ├─ fact_adverse_event        （不良事件明细）
   ├─ fact_recurrence_metastasis（复发转移明细）
   ├─ fact_response_assessment  （疗效评估明细）
   ├─ fact_functional_assessment（功能评价明细）
   ├─ fact_followup             （随访明细）
   ├─ fact_lab_test             （检验明细）
   └─ fact_imaging              （影像明细）
```

### 3.2 表结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `event_id` | PK | 由 patient_id + event_date + event_type + seq 确定性生成 |
| `patient_id` | FK | 锚点 |
| `tumor_id` | FK, nullable | 针对哪个肿瘤；患者级事件（随访、合并症）为空 |
| `event_type` | enum | surgery / pathology / molecular / medication / radiotherapy / complication / adverse_event / recurrence / response / functional / followup / lab / imaging / diagnosis / death |
| `event_date` | date | 事件发生日（时间轴锚点，必填） |
| `event_date_precision` | enum | day / month / year —— 历史数据常只有年月，须显式标注精度 |
| `parent_event_id` | FK, nullable | 父事件：并发症→手术，不良事件→用药，病理→手术 |
| `admission_no` | varchar | 住院流水号（关联键，非主锚点） |
| `source_doc_type` | varchar | 该事件来自哪类文书（血缘用，**不参与结构设计**） |
| — | — | 另含 5.3 节通用血缘/治理/AI 审计字段 |

### 3.3 event_date_precision 的必要性

真实世界数据里大量存在"2019年3月"甚至"2019年"这种精度。若强行补成 2019-03-01 存入，会造成两个后果：一是无法区分"确实是1号"和"只知道是3月"；二是算 OS/DFS 天数时产生虚假精度。

**做法**：日期字段存可用的最细值，同时标注精度；规则引擎在计算时序时读取精度，对低精度数据可选择排除或标记结果不确定。

---

## 3A. 一对多事件的通用处理范式

> 患者的随访、用药、并发症、影像检查、功能评价……都是**一个患者对应多条记录**。
> 本章以随访为例给出通用范式，其余一对多事件同理。工程实现时反复适用。

### 3A.1 错误做法：在患者表上横向加列

```
dim_patient
  followup_1_date, followup_1_status
  followup_2_date, followup_2_status
  ...
```

| 问题 | 说明 |
|---|---|
| **列数无上限** | 随访 5 年每 3 月一次即 20 次，部分患者随访 10 年以上。建 20 列，第 21 次无处可放 |
| **绝大部分为空** | 新入组患者仅 1 次随访，其余 19 组列全为 NULL |
| **查询困难** | "末次随访状态"需一串 COALESCE 倒序找非空列；"CEA 变化趋势"基本无法表达 |
| **加字段是灾难** | 随访新增"本次是否复查肠镜"，需加 20 个列 |

### 3A.2 正确做法：长表，一次事件一行

```
fact_followup
─────────────────────────────────────────────────────────────
patient_id  followup_date  round  vital_status  disease_status  ecog
P001        2024-03-15     1      存活          无瘤            0
P001        2024-06-20     2      存活          无瘤            0
P001        2024-09-18     3      存活          复发            1
P001        2024-12-25     4      死亡          —               —
P002        2024-05-10     1      存活          无瘤            0
```

- **加随访 = 加行**，随访 100 次即 100 行，表结构不变。
- **加字段 = 加一列**，所有历史记录自动具备该字段。

### 3A.3 两类查询模式（设计须同时支持）

| 查询类型 | 用途 | 实现 |
|---|---|---|
| **最新状态** | 大盘显示患者当前情况、队列筛选当前无瘤者 | 取该患者 `followup_date` 最大的一行 |
| **完整轨迹** | ECOG 随时间变化、CEA 趋势、随访依从性、恢复曲线 | 取该患者全部行按日期排序 |

第二类正是长表的价值——宽表做第一类尚可凑合，做第二类基本不可行。

### 3A.4 关键设计：患者表快照 vs 事件表事实

`dim_patient` 上有 `vital_status` 与 `last_followup_date`，`fact_followup` 每行也有 `vital_status`。**这是有意为之的冗余，但必须明确规则，否则两边会不一致。**

| 位置 | 性质 | 可否人工修改 |
|---|---|---|
| `fact_followup.vital_status` | **事实**——该次随访当时观察到的状态，历史记录 | 仅治理修正，且留审计 |
| `dim_patient.vital_status` | **快照**——当前最新状态，由随访事件自动刷新 | **禁止人工直接改** |

**为何保留快照**：生存分析需要"末次随访日"作为删失时点。若每次统计都扫描全部随访记录取最大值，1.7 万患者的 KM/Cox 计算会显著变慢，故物化一份。

🔴 **工程红线**：
- 患者表快照必须由随访事件**触发重算**（写入或修正随访记录后立即刷新）。
- 该刷新链路断裂是**最易发生且最难察觉的缺陷**——表现为大盘显示"存活"但随访记录已录入死亡。
- 必须有一致性校验任务：定期比对快照与最新随访记录，不一致则告警。

### 3A.5 随访中发现的新事件：不塞进随访记录

第 3 次随访发现肝转移，该信息**不写入随访记录的备注字段**，而是拆开：

| 记录什么 | 落在哪张表 | 内容 |
|---|---|---|
| 这次随访本身 | `fact_followup` | 随访日期、方式、当时疾病状态判断 |
| 这个转移灶 | `fact_recurrence_metastasis` | 部位、检出日、检出方式、病灶数、大小 |
| 二者关联 | `event_id` / `parent_event_id` | 该转移灶由哪次随访发现 |

**理由**（2A.3 判定标准的直接应用）：转移灶是**独立于任何场景客观存在的医学实体**，有自己的属性、有后续治疗、需被统计与筛选。若塞进随访备注文本，"肝转移患者有多少"这类基本查询就需解析自由文本。

**同理适用**：随访中发现的并发症 → `fact_complication`；随访中做的检验 → `fact_lab_test`；随访中的功能量表 → `fact_functional_assessment`。

### 3A.6 该范式适用的其他事件

| 事件 | 表 | 一对多的含义 |
|---|---|---|
| 用药 | `fact_medication` | 一个患者多个药品、多个周期 |
| 并发症 | `fact_complication` | 一次手术多个并发症 |
| 分子检测 | `fact_molecular_test` | 多个检测项目、多个时点、多种标本 |
| 复发转移 | `fact_recurrence_metastasis` | 多个病灶、多次进展 |
| 功能评价 | `fact_functional_assessment` | 多个时点、多种量表 |
| 检验 | `fact_lab_test` | 一项一行，长表 |

**统一判断**：凡"同一患者可能发生多次"的，一律建事件表按行存储，**绝不在维度表横向扩列**。

---

## 4. 维度表

### 4.1 dim_patient —— 患者（唯一锚点）

**只存"属于这个人、且相对稳定"的属性**。凡是会随时间变化的（体重、ECOG、分期），都属于事件，不放这里。

| 字段组 | 字段 | 说明 |
|---|---|---|
| 主键 | `patient_id` | UUID5 / 确定性哈希，不含明文身份 |
| 身份（受控） | `id_card_hash` `hospital_no_hash` | 哈希存储，明文需 raw 权限 |
| 人口学 | `gender` `birth_date` `birth_date_precision` `nationality` `education` `occupation` | — |
| 社会属性 | `urban_rural` `residence_region` `marital_status` | 公平性/可及性分层轴 |
| 医保属性 | `insurance_type` `insured_region` | **下一阶段启用**，本轮建字段留空 |
| 基线状态 | `blood_type` `family_history_flag` | 家族史明细另表 |
| 生存结局 | `vital_status` `death_date` `death_date_precision` `death_cause` | 患者级终点，不属于任一肿瘤 |
| 末次随访 | `last_followup_date` | 由随访事件推导刷新，用于生存分析删失 |
| 治理属性 | `data_completeness_score` `governance_status` | 规则计算 |
| 授权属性 | `ai_training_permitted` `authorized_scope` `vectorization_status` | 入库边界控制 |

**不放这里的**：ECOG（随时间变，进事件表）、身高体重（同上）、分期（属于肿瘤）、合并症（独立表，可多条）。

### 4.2 dim_tumor —— 肿瘤（第二锚点）

| 字段 | 说明 |
|---|---|
| `tumor_id` | PK |
| `patient_id` | FK |
| `tumor_seq` | 该患者第几个原发灶（1,2,3…） |
| `primary_site` | 原发部位（盲肠/升结肠/肝曲/横结肠/脾曲/降结肠/乙状结肠/直乙交界/直肠…） |
| `distance_from_anal_verge` | 距肛缘距离(cm) —— 直肠癌保肛决策核心变量 |
| `laterality` | 左半/右半结肠 —— 预后与用药选择相关 |
| `diagnosis_date` `diagnosis_date_precision` | 确诊日期 |
| `diagnosis_basis` | 确诊依据（病理/影像/临床） |
| `histology_type` | 组织学类型（初诊） |
| `clinical_t` `clinical_n` `clinical_m` `clinical_stage` | **初诊临床分期**（治疗前，cTNM） |
| `stage_system_version` | AJCC 第几版 —— 跨年份数据必须标注 |
| `synchronous_flag` | 是否同时性多原发（由 tumor_seq + 诊断日期间隔推导） |
| `tumor_status` | 当前状态：无瘤/带瘤/复发/进展（**派生字段**，由事件推导） |

**说明**：
- **cTNM 放这里，pTNM 放病理表**。二者是不同时点、不同依据的两套分期，混存会导致取数错误。
- `stage_system_version` 必须有：AJCC 7 版与 8 版对结直肠癌 N 分期定义有差异，跨年份队列不标版本无法比较。
- `tumor_status` 是派生的，不直录。

### 4.3 dim_center —— 医疗机构

| 字段 | 说明 |
|---|---|
| `center_id` `center_name` `center_level` `region` | 多中心场景基础；单中心阶段也需建，避免后期改造 |

---

## 5. 治疗类事实表

### 5.1 fact_surgery —— 手术

一次手术一行；同次住院多次手术为多行。

| 字段组 | 字段 |
|---|---|
| 关联 | `surgery_id`(PK) `event_id` `patient_id` `tumor_id` `surgery_no`(手术流水号) |
| 时间 | `surgery_date` `surgery_start_time` `surgery_end_time` `duration_min` |
| 术式 | `procedure_type`(术式分类) `procedure_name` `surgical_intent`(根治/姑息/减瘤/急诊) |
| 入路平台 | `approach`(开放/腹腔镜/机器人/经肛/经自然腔道) `conversion_to_open`(是否中转开腹) `conversion_reason` |
| 保肛相关 | `sphincter_preservation`(是否保肛) `anastomosis_type`(吻合方式) `anastomosis_distance_cm`(吻合口距肛缘) `anastomosis_quality`(吻合口质量评估) |
| 造口 | `stoma_created` `stoma_type`(肠造口术类型) `stoma_reason`(造口原因) `stoma_closure_date`(还瘘日期) |
| 术中 | `blood_loss_ml` `transfusion_flag` `transfusion_volume` `lymph_node_dissection_extent`(D1/D2/D3) `combined_resection`(联合脏器切除) |
| 技术标记 | `icg_navigation` `nos_specimen_extraction` `platform_brand` |
| 团队 | `surgeon_id` `assistant_ids` `center_id` |
| 结局 | `r_status`(R0/R1/R2) |

**说明**：
- `stoma_closure_date` 在此表——它是造口这件事的组成部分。造口状态（现存/已还纳/永久）是**派生标签**，由 `stoma_created` + `stoma_type` + `stoma_closure_date` 推导，不建物理列。
- 保肛相关字段是本轮首个应用场景（器械与术式 RWE）的核心，须完整。

### 5.2 fact_pathology —— 病理

| 字段组 | 字段 |
|---|---|
| 关联 | `pathology_id`(PK) `event_id` `patient_id` `tumor_id` `parent_event_id`(对应手术) |
| 标本 | `specimen_type`(手术标本/活检/穿刺) `specimen_date` `report_date` `pathology_no` |
| 组织学 | `histology_type` `differentiation_grade` `mucinous_component` `signet_ring_component` |
| 侵犯 | `invasion_depth` `lymphovascular_invasion` `perineural_invasion` `tumor_deposits` |
| 淋巴结 | `ln_examined`(检出数) `ln_positive`(阳性数) —— 阳性率派生 |
| 切缘 | `proximal_margin` `distal_margin` `crm_status`(环周切缘) `crm_distance_mm` |
| **病理分期** | `pathologic_t` `pathologic_n` `pathologic_m` `pathologic_stage` `stage_system_version` `ypTNM_flag`(是否新辅助后) |
| 新辅助疗效 | `trg_grade`(肿瘤消退分级 TRG0-3) |
| 肿瘤特征 | `tumor_size_cm` `gross_type` |

**说明**：
- **pCR 不建字段**，由 `trg_grade = TRG0` 推导（详见技术方案 12.4）。
- `ypTNM_flag` 必须有：新辅助治疗后的分期是 ypTNM，与直接手术的 pTNM 不可混用于队列分析。
- 淋巴结检出数 ≥12 是质控指标，由 `ln_examined` 派生判定，不直录。

### 5.3 fact_molecular_test —— 分子检测

**一个检测项目一行**（非一次送检一行），因为不同标志物可能不同时间、不同标本、不同方法检测。

| 字段 | 说明 |
|---|---|
| `molecular_id`(PK) `event_id` `patient_id` `tumor_id` | 关联 |
| `test_item` | 检测项目：KRAS/NRAS/BRAF/PIK3CA/HER2/NTRK/MSI/MMR/TMB/ctDNA |
| `test_date` `report_date` | 时间 |
| `specimen_type` | 原发灶/转移灶/血浆 ctDNA —— **必须区分**，不同标本结果可能不一致 |
| `specimen_source_event_id` | 标本来自哪次手术/活检 |
| `test_method` | PCR/NGS/IHC/FISH/Sanger |
| `result_qualitative` | 突变/野生型/阳性/阴性/MSI-H/MSS/dMMR/pMMR |
| `mutation_site` | 具体位点（G12C/G12D/V600E…） |
| `result_quantitative` `result_unit` | TMB 值、丰度等 |
| `mmr_protein_detail` | MLH1/MSH2/MSH6/PMS2 四项分别的表达状态 |
| `testing_lab` `platform` `reagent` | 检测机构与平台 |

**说明**：MMR 四个蛋白必须能分别记录——只存"dMMR/pMMR"会丢失"哪个蛋白缺失"，而这与 Lynch 综合征筛查直接相关。

### 5.4 fact_medication —— 用药

**一个药品一行**（非一个方案一行）。这是本表最关键的设计决定。

| 字段 | 说明 |
|---|---|
| `medication_id`(PK) `event_id` `patient_id` `tumor_id` | 关联 |
| `regimen_id` | **方案组标识**——同一方案下的多个药品共享此 ID |
| `regimen_name` | 方案名（FOLFOX/CAPEOX/FOLFIRI…） |
| `drug_generic_name` `drug_trade_name` `drug_category` | 药品（化疗/靶向/免疫/内分泌/支持治疗） |
| `treatment_intent` | 新辅助/辅助/转化/姑息/维持 |
| `treatment_line` | 治疗线数（1/2/3…） |
| `start_date` `end_date` | 起止 |
| `cycle_number` `planned_cycles` `actual_cycles` | 周期 |
| `dose` `dose_unit` `dose_intensity` `route` `frequency` | 剂量与给药 |
| `dose_adjusted` `dose_adjust_reason` | 剂量调整 |
| `discontinuation_reason` | 停药原因（完成/进展/毒性/患者拒绝/经济/死亡…） |

**为什么必须拆到药品级**：
- 只存"CAPEOX"这个方案名，无法回答"用了奥沙利铂多少累积剂量""因神经毒性减量的比例"这类药企 RWS 的核心问题；
- 方案常有变更（如奥沙利铂因毒性停用、卡培他滨继续），方案级记录无法表达；
- 用 `regimen_id` 分组即可还原方案层视图，**细粒度可倒推粗粒度，反之不行**。

### 5.5 fact_radiotherapy —— 放疗

| 字段 | 说明 |
|---|---|
| `radiotherapy_id`(PK) `event_id` `patient_id` `tumor_id` | 关联 |
| `rt_intent` | 新辅助/辅助/姑息 |
| `rt_technique` | 3D-CRT/IMRT/VMAT/SBRT |
| `target_site` | 靶区部位 |
| `total_dose_gy` `fraction_dose_gy` `fraction_count` | 剂量分割 |
| `start_date` `end_date` | 起止 |
| `concurrent_chemo_flag` `concurrent_regimen_id` | 是否同步放化疗、关联哪个方案 |
| `completion_status` | 完成/中断 + `interruption_reason` |

### 5.6 fact_complication —— 并发症

挂 `parent_event_id`（对应手术）。一次手术可多条并发症。

| 字段 | 说明 |
|---|---|
| `complication_id`(PK) `event_id` `patient_id` `parent_event_id`(手术) | 关联 |
| `complication_type` | 类型（吻合口漏/出血/感染/肠梗阻/切口裂开…，挂标准术语） |
| `onset_date` `days_after_surgery` | 发生时间（天数派生） |
| `intervention_required` | 是否需要干预 |
| `intervention_measures` | 干预措施（JSONB 多选：药物/输血/TPN/内镜/介入/再手术/ICU） |
| `general_anesthesia_required` | 干预是否需全麻（**CD IIIa/IIIb 分界依据**） |
| `organ_failure` | 器官衰竭情况（单/多器官，**IVa/IVb 分界依据**） |
| `icu_admission` `icu_days` | ICU |
| `outcome` | 转归（治愈/好转/未愈/恶化/死亡） |
| `cd_grade` | CD 分级 —— **优先由干预事实推导**；无法推导时人工补充 |
| `cd_grade_source` | 取得方式：自动推导/人工补充/录入端直给 |

**说明**：CD 分级的本质是"按矫正所需干预强度分级"，故干预字段必须足够细（是否全麻、是否 ICU、器官衰竭数），才能支撑自动推导。

### 5.7 fact_adverse_event —— 不良事件

挂 `parent_event_id`（对应用药/放疗）。与并发症分表，因二者归因、分级体系、监管口径均不同。

| 字段 | 说明 |
|---|---|
| `ae_id`(PK) `event_id` `patient_id` `parent_event_id`(用药/放疗) | 关联 |
| `ae_term` `meddra_code` | 事件名称与编码 |
| `ctcae_grade` `ctcae_version` | CTCAE 分级与版本（版本必须记，各版分级标准有差异） |
| `onset_date` `resolution_date` | 起止 |
| `serious_flag` `serious_criteria` | 是否 SAE 及判定依据（死亡/危及生命/住院/致残/先天异常） |
| `causality` | 与药物相关性（肯定/很可能/可能/可疑/无关） |
| `suspected_drug_id` | 可疑药物（关联 fact_medication） |
| `action_taken` | 采取措施（停药/减量/暂停/未调整） |
| `outcome` | 转归 |

### 5.8 fact_recurrence_metastasis —— 复发转移

**一个病灶一行**，多部位转移为多行。

| 字段 | 说明 |
|---|---|
| `recurrence_id`(PK) `event_id` `patient_id` `tumor_id` | 关联 |
| `lesion_type` | 局部复发/区域淋巴结/远处转移 |
| `site` | 部位（肝/肺/腹膜/骨/脑/远处淋巴结…） |
| `site_detail` | 具体位置（如肝 S6 段） |
| `detection_date` `detection_date_precision` | **首次检出日**（异时性推导的关键原子事实） |
| `detection_method` | 检出方式（CT/MRI/PET-CT/病理/肠镜/查体） |
| `pathology_confirmed` | 是否病理确诊 |
| `lesion_count` `max_diameter_mm` | 病灶数与大小 |
| `resectable_assessment` | 可切除性评估 |
| `treatment_received` | 针对该病灶的治疗 |

**说明**：**同时性/异时性不建字段**，由 `detection_date` − 原发灶手术日 ≥6 月推导，基准日与阈值为规则参数（详见技术方案 12.3）。初诊即 M1 者单独打标、不参与"术后新发"推导。

### 5.9 fact_response_assessment —— 疗效评估

| 字段 | 说明 |
|---|---|
| `assessment_id`(PK) `event_id` `patient_id` `tumor_id` | 关联 |
| `assessment_date` | 评估日 |
| `assessment_context` | 评估场景（新辅助后/一线治疗中/维持期…） |
| `related_regimen_id` | 针对哪个治疗方案 |
| `criteria` `criteria_version` | 标准（RECIST 1.1 / iRECIST） |
| `target_lesion_sum_mm` | 靶病灶径线和 |
| `best_response` | CR/PR/SD/PD |
| `progression_flag` `progression_date` | 进展标记与日期（PFS 推导用） |
| **cCR 三项** | `imaging_no_residual` `endoscopy_no_residual` `dre_no_residual` + 各自检查日期 |

**说明**：**cCR 不建字段**，由影像 + 内镜 + **临床指检**三项俱无残留推导；任一项未做则标"证据不完整·无法判定"，不得默认成立（详见技术方案 12.4）。cCR 与 pCR 是两个独立概念，禁止合并字段。

### 5.10 fact_functional_assessment —— 功能评价（LARS 等）

**一次评估一行**，患者多时点多行。

| 字段 | 说明 |
|---|---|
| `assessment_id`(PK) `event_id` `patient_id` `surgery_no`(关联手术) | 关联 |
| `scale_type` | 量表类型（LARS / QLQ-C30 / CR29 / Wexner…） |
| `scale_version` | 量表版本 |
| `planned_timepoint` | 计划时点（术后 3/6/9…月；超期标"计划外"） |
| `assessment_date` | 实际评估日 |
| `days_after_surgery` | 距术天数（派生） |
| `item_responses` | **JSONB：各条目原始作答** —— 原子事实，只存这一层 |
| `assessment_mode` | 评估方式（门诊/电话/线上问卷） |

**说明**：
- **总分与分级不建字段**，由条目原始作答按量表计分规则推导，阈值为带版本参数。
- 用 JSONB 存条目是因为不同量表条目数差异大（LARS 5 条、QLQ-C30 30 条），建固定列不现实；但**条目原始值本身是结构化的**，JSONB 内部有 schema 约束。
- 漏访 = 该计划时点无记录，不填空值行。

### 5.11 fact_followup —— 随访

| 字段 | 说明 |
|---|---|
| `followup_id`(PK) `event_id` `patient_id` | 关联 |
| `followup_date` | 随访日 |
| `followup_round` | 第几次随访 |
| `followup_method` | 方式（门诊/电话/住院/线上） |
| `vital_status` | 本次随访时生存状态 |
| `disease_status` | 疾病状态（无瘤/带瘤稳定/进展/复发） |
| `ecog_ps` | 本次 ECOG（**随时间变，故在事件表不在患者表**） |
| `body_weight` `bmi` | 体重（同上） |
| `readmission_flag` `admission_date` `discharge_date` | 再入院相关 —— **30 天再入院由时间戳推导，不建字段** |
| `lost_to_followup_flag` | 失访标记 |

### 5.12 fact_lab_test / fact_imaging —— 检验与影像

| 表 | 关键字段 |
|---|---|
| `fact_lab_test` | `test_item`(CEA/CA19-9/血常规/肝肾功…) `test_date` `result_value` `result_unit` `reference_range` `abnormal_flag` |
| `fact_imaging` | `modality`(CT/MRI/PET-CT/超声) `exam_date` `body_part` `finding_summary` `impression` `structured_findings`(JSONB) |

**说明**：检验采用"一项一行"的长表设计，而非每个指标一列——指标种类会不断增加，宽表设计每加一项就要改表。

---

## 6. 患者级附属表

### 6.1 fact_comorbidity —— 合并症

| 字段 | 说明 |
|---|---|
| `comorbidity_id`(PK) `patient_id` | 关联（挂患者，不挂肿瘤） |
| `condition_name` `icd10_code` | 疾病名称与编码 |
| `diagnosis_date` | 诊断日期 |
| `status` | 现患/既往/已治愈 |
| `severity` | 严重程度 |
| `charlson_weight` | 该项在 Charlson 指数中的权重 |

**说明**：Charlson 指数总分**不存字段**，由各条合并症权重推导。

### 6.2 fact_family_history / fact_lifestyle

| 表 | 关键字段 |
|---|---|
| `fact_family_history` | `relative_type`(一级/二级亲属) `cancer_type` `onset_age` —— Lynch 综合征筛查依据 |
| `fact_lifestyle` | `smoking_status` `pack_year` `drinking_status` `bmi_baseline` `record_date` |

---

## 6A. 医患沟通数据（三层结构）

> 患者与医生的对话记录（微信、APP、电话、门诊问答）纳入本体的设计。
> 这类数据与手术、病理等结构化事件差异显著，须专门设计，不可简单存为文本字段。

### 6A.1 本体定位

按 2A.3 判定标准：**医患沟通是客观发生过的事件**，有时间、有参与方、有内容，故属于本体，`event_type = communication`。

但它有三个特性与其他事件不同，决定了必须分层：

| 特性 | 与结构化事件的差异 | 设计影响 |
|---|---|---|
| **非结构化** | 手术记录再乱仍有固定要素；对话是自然语言流 | 原文层不做结构化约束 |
| **单条价值低，价值在整段** | "好的谢谢医生"无信息量；整段对话可能含症状、用药反馈、AE 描述 | 会话（Session）才是分析单元 |
| **隐私敏感度最高** | 常混入身份证号、电话、住址、家属信息、缴费凭证、患处照片 | 访问控制与脱敏须显著严于结构化字段 |

### 6A.2 三层结构

🔴 **核心设计：既不能只存原文（无法分析），也不能只存抽取结果（无法追溯）。三层并存。**

```
第一层 dim_communication_session   会话     ← 结构化、可统计、本体实体
        └─ 第二层 fact_communication_message   消息原文  ← 严格访问控制
                └─ 第三层 抽取出的临床事实      ← 各回各表，不留在对话表
```

### 6A.3 第一层：dim_communication_session（会话）

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | uuid | 主键 |
| `patient_id` | uuid | 关联患者 |
| `admission_id` | uuid | 可空，关联住院 |
| `related_event_id` | uuid | 可空，关联手术/治疗阶段 |
| `channel` | enum | 微信 / APP / 电话 / 门诊问答 / 短信 |
| `session_start` | timestamp | 会话起始 |
| `session_end` | timestamp | 会话结束 |
| `message_count` | int | 消息条数 |
| `participant_roles` | array | 患者 / 家属 / 主诊医生 / 护士 / 个案管理师 |
| `days_from_surgery` | int | 派生，距手术天数 |
| `treatment_phase` | enum | 派生，术前/围手术期/辅助治疗期/随访期 |
| `extraction_status` | enum | 未抽取 / 已抽取 / 人工复核完成 |

**这一层是结构化的、可统计的**——可回答"术后 30 天内沟通频次与并发症发生的关系""哪个治疗阶段患者咨询最密集"。

### 6A.4 第二层：fact_communication_message（消息原文）

| 字段 | 类型 | 说明 |
|---|---|---|
| `message_id` | uuid | 主键 |
| `session_id` | uuid | 关联会话 |
| `sender_role` | enum | 患者 / 家属 / 医生 / 护士 |
| `sent_at` | timestamp | 发送时间 |
| `content_type` | enum | 文字 / 图片 / 语音转写 / 文件 |
| `content_text` | text | 文本内容（图片仅存描述，不存原图于本表） |
| `deidentified` | boolean | 是否已完成去标识化 |
| `contains_sensitive` | boolean | 标记疑含身份/财务信息，待处理 |

🔴 **访问控制（严于全库其他表）**：

| 角色 | 可否访问原文 |
|---|---|
| 主诊医生（本人患者） | ✅ |
| 治理专员 | ✅ 抽取复核期间 |
| 科研人员 | ❌ **完全不可见**，仅可用第三层抽取结果 |
| 数据导出 | ❌ **原文一律不出库** |

### 6A.5 第三层：抽取出的临床事实（各回各表）

🔴 **抽取出的事实不留在对话表中，写入对应的既有事实表。对话是来源，不是归宿。**

（与 3A.5 随访中发现转移灶的处理原则一致）

| 对话中提到 | 写入表 | 示例 |
|---|---|---|
| "这两天手脚发麻" | `fact_adverse_event` | 奥沙利铂周围神经毒性 |
| "伤口红肿有渗液" | `fact_complication` | 切口感染 |
| "药太贵，我停了" | `fact_medication`（停药原因） | 经济原因停药 |
| "一天要跑七八次厕所" | `fact_functional_assessment` | LARS 相关主诉 |
| "吃了想吐，没吃完" | `fact_medication`（依从性） | 剂量未完成 |

每条抽取记录必须携带溯源：`source_type='communication'`、`source_session_id`、`source_message_id`。

### 6A.6 可靠性分级（必须处理）

患者自述"我发烧 38 度"与医生查房记录的体温，**证据等级不同**，不可混同统计。

| `evidence_level` | 含义 | 来源 |
|---|---|---|
| `objective_measured` | 系统精确计量 | HIS、检验、医保结算 |
| `clinician_assessed` | 临床专业判断 | 医生记录、专家判定 |
| `patient_reported` | **患者自报** | **医患对话、患者填报** |

🔴 **凡从对话抽取的事实，一律标记 `evidence_level = patient_reported`。** 科研分析时研究者可自主选择是否纳入自报数据，且论文中须如实标注。

此分级与仲裁原则一致：能被系统精确计量的信系统、需专业判断的信专家、患者自报独立标识不与前两者混用。

### 6A.7 隐私与去标识化（严于其他数据）

| 处理项 | 要求 |
|---|---|
| 去标识范围 | 除姓名/住院号外，须清理：家属称谓与姓名、电话、地址、身份证号、缴费与转账信息、患处照片 |
| 图片处理 | **原图不入库**，仅由人工或本地模型转为文字描述后入库 |
| AI 抽取路径 | ⚠️ **对话原文默认不走云端**，仅用本地模型抽取 |
| 未去标识数据 | `deidentified=false` 的记录禁止进入任何分析视图 |

**为何原文不走云端**：对话内容混合身份、财务、家庭信息，即使去标识也难保证清理完全；相较结构化字段，风险与收益不成比例。待本地模型能力验证充分后再评估。

### 6A.8 纳入本体的价值

| 价值点 | 说明 |
|---|---|
| **轻中度 AE 的发现** | 大量轻中度不良事件患者在沟通中提及但未至门诊，HIS 无记录——真实世界数据的空白区 |
| **停药原因一手来源** | "太贵停了""吃了想吐"是停药与依从性的直接证据，病历中通常缺失 |
| **LARS 主诉互证** | 患者日常排便描述可与量表评分交叉验证 |
| **患者体验的可核验化** | 满意度因主观不可核验被挡在准入线外（见 12.2）；但**对话中的具体主诉是可核验的事实**，为患者体验维度提供了合规路径 |

---

## 7. 关系总览

```
dim_patient (patient_id)
  ├─ dim_tumor (tumor_id) ──┐
  │                          ├─ fact_surgery ──┬─ fact_complication (parent=surgery)
  │                          │                 └─ fact_pathology (parent=surgery)
  │                          ├─ fact_molecular_test
  │                          ├─ fact_medication ─── fact_adverse_event (parent=medication)
  │                          ├─ fact_radiotherapy
  │                          ├─ fact_recurrence_metastasis
  │                          └─ fact_response_assessment
  ├─ fact_followup
  ├─ fact_functional_assessment
  ├─ fact_comorbidity
  ├─ fact_family_history
  ├─ fact_lifestyle
  ├─ fact_lab_test
  ├─ fact_imaging
  └─ dim_communication_session ─── fact_communication_message
         │
         └─（抽取）─► 回写至 fact_adverse_event / fact_complication /
                       fact_medication / fact_functional_assessment
                       并标记 evidence_level=patient_reported
                       + source_session_id / source_message_id

fact_clinical_event 横贯所有事件（event_id 统一时间轴）
```

**关于医患沟通链路**：会话与消息是**来源**，抽取出的临床事实**各回各表**（见 6A.5），不留存于对话表内。原文层受最严格访问控制，科研人员仅可见抽取结果。

---

## 8. 本模型不建的字段（全部由规则推导）

| 派生标签 | 依据的原子事实 |
|---|---|
| 同时性/异时性转移 | 转移检出日 − 原发灶手术日，阈值 6 月（参数化） |
| CD 分级 | 干预措施 + 是否全麻 + ICU + 器官衰竭 |
| pCR | trg_grade = TRG0 |
| cCR | 影像 + 内镜 + 指检三项俱无残留 |
| 造口状态（现存/已还纳/永久） | stoma_created + stoma_type + stoma_closure_date |
| 30 天再入院 | 本次入院日 − 上次出院日 ≤ 30 天 |
| LARS 总分与分级 | 条目原始作答 + 计分规则 |
| Charlson 指数 | 各合并症权重求和 |
| OS / DFS / PFS | 各事件日期 + 生存状态 |
| 淋巴结检出达标(≥12) | ln_examined |
| 肿瘤当前状态 | 最新的复发转移/疗效评估事件 |

**工程红线**：以上任一项若被建成物理列并直接录入，视为违反"事实与结论分离"原则。

---

## 9. 待医疗团队确认

1. `dim_tumor` 三层骨架是否认可（尤其多原发场景的处理）。
2. 用药拆到药品级、用 `regimen_id` 分组还原方案，是否认可。
3. 并发症与不良事件分两张表（归因与分级体系不同），是否认可。
4. 检验采用长表（一项一行），是否认可。
5. 功能评价条目用 JSONB 存储，是否接受（理由见 5.10）。
6. 各表是否有遗漏的关键临床字段。
