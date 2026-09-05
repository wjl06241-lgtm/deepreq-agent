# DACCA 数据字典 · 值域代码表 v0.2 补充（放疗/随访/检验影像/功能评价）

> 补全 v0.1 暂缺的四组表；标签规则同 v0.1。功能评价计分规则依赖 LARS 研究组样例（E2），先建结构。

## 9. fact_radiotherapy 放疗

| 字段 | 值域 | 来源 |
|---|---|---|
| rt_intent | 1 新辅助；2 辅助；3 姑息；4 根治性（未手术） | 〔建议〕 |
| rt_technique | 1 3D-CRT；2 IMRT；3 VMAT；4 SBRT；99 其他 | 〔建议〕 |
| target_site | 1 盆腔原发灶；2 瘤床；3 转移灶；99 其他 | 〔建议〕 |
| completion_status | 1 按计划完成；2 中断；3 调整后完成 | 〔建议〕 |
| interruption_reason | 1 毒性；2 疾病进展；3 患者意愿；4 设备/流程；99 其他 | 〔建议〕 |

## 10. fact_followup 随访

| 字段 | 值域 | 来源 |
|---|---|---|
| followup_method | 1 门诊；2 电话；3 住院；4 线上问卷 | 〔建议〕 |
| vital_status | 1 存活；2 死亡；9 失访/未知（与 dim_patient 同字典） | 〔团标〕 |
| disease_status | 1 无瘤；2 带瘤稳定；3 进展；4 复发；9 未知 | 〔建议〕 |
| ecog_ps | 0-5；9 未知 | 〔团标〕 |
| lost_to_followup_flag | T/F | 〔建议〕 |
| readmission_flag | T/F（30 天再入院由 admission_date−上次 discharge_date 推导，**不建物理列**） | 〔建议〕 |

## 11. fact_lab_test / fact_imaging 检验影像

| 字段 | 值域 | 来源 |
|---|---|---|
| test_item | 1 CEA；2 CA19-9；3 血常规；4 肝肾功能；5 凝血；99 其他（长表，新增指标=新增枚举） | 〔建议〕 |
| abnormal_flag | 1 正常；2 偏高；3 偏低；4 未评 | 〔建议〕 |
| modality | 1 CT；2 MRI；3 PET-CT；4 超声；5 内镜；99 其他 | 〔建议〕 |
| body_part | 1 腹盆；2 胸；3 肝；4 全腹；99 其他 | 〔建议〕 |
| structured_findings | JSONB（结构化发现：病灶部位/大小/数量，供 RECIST 靶病灶径线和提取） | 〔建议〕 |

## 12. fact_functional_assessment 功能评价

| 字段 | 值域 | 来源 |
|---|---|---|
| scale_type | 1 LARS；2 QLQ-C30；3 QLQ-CR29；4 Wexner；99 其他 | 〔建议〕 |
| scale_version | 版本号字符串（计分规则随版本参数化） | 〔建议〕 |
| planned_timepoint | 3M/6M/9M/12M/18M/24M/计划外（术后月数；漏访=无记录，不填空行） | 〔建议〕 |
| assessment_mode | 1 门诊；2 电话；3 线上问卷 | 〔建议〕 |
| item_responses | JSONB：条目原始作答（**只存这一层**；总分/分级由计分规则推导，不建列） | 〔建议〕 |

## 13. 待专科确认（v0.2 新增，并入台账）

1. 放疗技术/靶区/中断原因取值；
2. 随访 disease_status 与复发转移事件表的记录边界（同一事实谁为主记录）；
3. 检验指标枚举起步清单（先登记多少项）；
4. 功能评价计划时点是否按「术后 3/6/9/12/18/24 月」口径；LARS 计分规则与 5 条目中文表述（等研究组样例，E2）。
