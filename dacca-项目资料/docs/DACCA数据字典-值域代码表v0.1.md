# DACCA 数据字典 · 值域代码表 v0.1

> 定位：把《医学实体表结构》中所有枚举字段的值域集中成表，供工程师建库与前端表单直接引用。
> 状态：v0.1（顾问建议），**待专科逐表校对后升级 confirmed**。
> 标签：〔团标〕= T/SHIA 016—2025 6.3 值域代码表有据；〔草案〕= 已有草案成文；〔建议〕= 顾问建议，待专科确认。
> 规范依据：《含医保维度特色数据库构建说明》7.2——枚举中文存储、必须含「未知/未记录」、需排序的用数值编码；所有枚举「只能加不能删」，停用标 deprecated。

## 0. 通用值域

| 字段 | 代码 | 值 | 来源 |
|---|---|---|---|
| gender 性别 | 1/2/9 | 男/女/未知 | 〔团标〕 |
| event_date_precision | day/month/year | 日/月/年 | 〔建议〕 |
| source_doc_type 文书类型 | surgery_record/pathology_report/molecular_report/discharge_summary/followup_record/consultation | 手术记录/病理报告/分子报告/出院小结/随访记录/医患沟通 | 〔建议〕 |

## 1. dim_patient / dim_tumor

| 字段 | 值域（代码=中文值） | 来源 |
|---|---|---|
| urban_rural | 1 城镇；2 农村；9 未知 | 〔团标〕 |
| insurance_type | 1 城镇职工医保；2 城乡居民医保；3 新农合；4 商业保险；5 自费；6 公费医疗；9 未知（**下一阶段启用**） | 〔建议〕 |
| marital_status | 1 未婚；2 已婚；3 离异；4 丧偶；9 未知 | 〔团标〕 |
| vital_status | 1 存活；2 死亡；9 失访/未知 | 〔团标〕 |
| death_cause | E1 肿瘤相关；E2 治疗相关；E3 其他 | 〔团标〕 |
| primary_site 原发部位 | 1 盲肠；2 升结肠；3 肝曲；4 横结肠；5 脾曲；6 降结肠；7 乙状结肠；8 直乙交界；9 直肠；99 其他/多原发 | 〔建议〕 |
| laterality | 1 左半；2 右半；9 未知 | 〔建议〕 |
| diagnosis_basis | 1 病理；2 影像；3 临床；4 手术探查 | 〔建议〕 |
| stage_system_version | 7=AJCC7；8=AJCC8（跨年份必须标注） | 〔建议〕 |
| synchronous_flag | T/F（由 tumor_seq+诊断间隔推导，不直录） | 〔建议〕 |

## 2. fact_surgery（器械术式 RWE 场景核心，值域最全）

| 字段 | 值域 | 来源 |
|---|---|---|
| surgical_intent | 1 根治；2 姑息；3 减瘤；4 急诊；9 未知 | 〔建议〕 |
| procedure_type 术式分类 | 1 LAR 低位前切除；2 ISR-A 部分内括约肌切除；3 ISR-B 次全内括约肌切除；4 ISR-C 全内括约肌切除；5 APR 腹会阴联合切除；6 左半结肠切除；7 右半结肠切除；8 乙状结肠切除；9 局部切除（TEM/TAMIS）；10 Hartmann；99 其他 | 〔医保文档枚举映射 + 建议扩充〕 |
| approach 入路 | 1 开放；2 腹腔镜；3 机器人；4 经肛；5 经自然腔道；6 双镜联合 | 〔建议〕 |
| conversion_to_open | T/F；conversion_reason 挂自由文本 | 〔建议〕 |
| sphincter_preservation | 1 保肛；0 不保肛（APR） | 〔建议〕 |
| anastomosis_type | 1 双吻合器；2 手工吻合；3 无吻合（造口）；4 侧端吻合；9 未知 | 〔建议〕 |
| anastomosis_quality | 1 完整无缺损；2 缺损可修复；3 缺损需重做 | 〔建议〕 |
| stoma_type | 1 回肠保护性造口；2 结肠造口；3 永久造口 | 〔建议〕 |
| stoma_reason | 1 预防性；2 治疗性（吻合口漏）；3 梗阻；4 肿瘤因素 | 〔建议〕 |
| lymph_node_dissection_extent | 1 D1；2 D2；3 D3 | 〔建议〕 |
| r_status | 0 R0；1 R1；2 R2；9 未知 | 〔建议〕 |
| platform_brand | 自由文本（厂商/平台，供创新维度统计） | 〔建议〕 |

## 3. fact_pathology

| 字段 | 值域 | 来源 |
|---|---|---|
| specimen_type | 1 手术标本；2 活检；3 穿刺；4 息肉切除 | 〔建议〕 |
| histology_type | 1 腺癌（NOS）；2 黏液腺癌；3 印戒细胞癌；4 髓样癌；5 神经内分泌癌；6 腺鳞癌；99 其他 | 〔团标〕 |
| differentiation_grade | 1 高分化；2 中分化；3 低分化；4 未分化；9 未知 | 〔团标〕 |
| lymphovascular_invasion / perineural_invasion | 0 无；1 有；9 未知 | 〔团标〕 |
| crm_status | 1 阳性(≤1mm)；0 阴性；9 未知 | 〔建议〕 |
| trg_grade | 0-3（TRG0=无肿瘤残留→推导 pCR） | 〔建议〕 |
| gross_type | 1 隆起型；2 溃疡型；3 浸润型；4 混合型 | 〔团标〕 |
| ypTNM_flag | T/F（新辅助后分期标记） | 〔建议〕 |

## 4. fact_molecular_test

| 字段 | 值域 | 来源 |
|---|---|---|
| test_item | 1 KRAS；2 NRAS；3 BRAF；4 PIK3CA；5 HER2(ERBB2)；6 NTRK；7 MSI；8 MMR；9 TMB；10 ctDNA；99 其他 | 〔草案〕 |
| test_method | 1 PCR；2 NGS；3 IHC；4 FISH；5 Sanger；99 其他 | 〔草案〕 |
| specimen_type | 1 原发灶；2 转移灶；3 外周血 ctDNA；4 其他 | 〔草案〕 |
| result_qualitative | 1 野生型；2 突变型；3 扩增/阳性；4 阴性；5 不确定（MSI 用 MSS/MSI-L/MSI-H；MMR 用 pMMR/dMMR，见说明） | 〔草案〕 |
| mmr_protein_detail | MLH1/MSH2/MSH6/PMS2 各 0 表达/1 缺失/9 未知（**必须分蛋白记录**） | 〔建议〕 |
| mutation_site | 自由文本或位点字典（G12C/G12D/V600E…，字典化待专科确认） | 〔草案〕 |

## 5. fact_medication

| 字段 | 值域 | 来源 |
|---|---|---|
| drug_category | 1 化疗；2 靶向；3 免疫；4 内分泌；5 支持治疗 | 〔草案〕 |
| treatment_intent | 1 新辅助；2 辅助；3 转化；4 姑息；5 维持 | 〔草案〕 |
| treatment_line | 1 一线；2 二线；3 三线；4 维持；5 其他 | 〔草案〕 |
| dose_unit | 1 mg；2 g；3 mg/m²；4 AUC；99 其他 | 〔草案〕 |
| route | 1 口服；2 静脉；3 皮下；4 腔内；99 其他 | 〔草案〕 |
| discontinuation_reason | 1 完成计划；2 疾病进展；3 不良反应；4 患者意愿；5 经济因素；6 死亡；99 其他 | 〔草案〕 |

## 6. fact_adverse_event / fact_complication

**不良事件（CTCAE 体系）：**

| 字段 | 值域 | 来源 |
|---|---|---|
| ctcae_grade | 1-5（5=相关死亡） | 〔草案〕 |
| ctcae_version | 5.0（当前）；版本必记 | 〔建议〕 |
| serious_criteria | 1 死亡；2 危及生命；3 住院/延长住院；4 致残；5 先天异常；6 其他重要医学事件 | 〔建议〕 |
| causality | 1 肯定；2 很可能；3 可能；4 可能无关；5 无关 | 〔草案〕 |
| action_taken | 1 未处理；2 对症；3 减量；4 暂停；5 永久停药 | 〔草案〕 |
| outcome | 1 恢复；2 好转；3 未恢复；4 后遗症；5 死亡 | 〔草案〕 |

**并发症（CD 体系，干预字段决定分级）：**

| 字段 | 值域 | 来源 |
|---|---|---|
| complication_type | 1 吻合口漏；2 出血；3 切口感染；4 腹腔感染；5 肠梗阻；6 切口裂开；7 泌尿系损伤；8 神经损伤；9 深静脉血栓；10 肺部感染；99 其他（挂标准术语） | 〔建议〕 |
| intervention_measures | JSONB 多选：药物/输血/TPN/内镜/介入/再手术/ICU | 〔建议〕 |
| general_anesthesia_required | T/F（CD IIIa/IIIb 分界） | 〔建议〕 |
| organ_failure | 0 无；1 单器官；2 多器官（IVa/IVb 分界） | 〔建议〕 |
| outcome | 1 治愈；2 好转；3 未愈；4 恶化；5 死亡 | 〔建议〕 |
| cd_grade_source | 1 自动推导；2 人工补充；3 录入端直给 | 〔建议〕 |

## 7. fact_response_assessment / fact_comorbidity

| 字段 | 值域 | 来源 |
|---|---|---|
| criteria | 1 RECIST 1.1；2 iRECIST | 〔建议〕 |
| best_response | 1 CR；2 PR；3 SD；4 PD；5 NE | 〔草案〕 |
| assessment_context | 1 新辅助后；2 一线治疗中；3 维持期；4 术后复查 | 〔建议〕 |
| comorbidity.status | 1 活动/未控；2 控制中；3 已缓解 | 〔草案〕 |
| comorbidity.severity | 1 轻；2 中；3 重 | 〔建议〕 |

## 8. 规范与红线（重复强调）

1. 所有枚举**必须含「99 其他」「9 未知/未记录」**，避免 NULL 与未知混用。
2. 需要排序的（分级/严重度）用数值编码存储；中文值面向人，编码面向程序。
3. 枚举**只能加不能删**；停用标 deprecated，历史数据可解析。
4. 第 8 节「不建的字段」清单（同时/异时、CD、pCR、cCR、造口状态、30 天再入院、LARS 总分、Charlson、OS/DFS/PFS、淋巴结达标、肿瘤状态）**一律不建物理列**，由规则引擎按本字典参数推导。
5. 值域变更走 FieldRegistry：改同义词即时生效；新增枚举即时生效；新增字段走 L2 工程流程。

## 9. 待专科确认（新增项，并入决策台账）

1. 术式分类 10 项是否覆盖本院实际（尤其经肛类、联合脏器切除的记法）；
2. 并发症类型 10 类术语清单；
3. 病理 gross_type/组织学取值与病理科报告用语的对应；
4. MSI/MMR 取值口径与 mmmr 蛋白明细是否按上述；
5. 其他表（放疗/随访/检验影像/功能评价）的值域暂缺，待 LARS 样例与放疗字段确认后补 v0.2。
