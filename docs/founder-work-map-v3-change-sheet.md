# Founder 工作地图 V3 生产变更单

日期：2026-09-24  
状态：Ivy 已确认业务修正；本地实现与验证完成；生产尚未写入

## 1. 本次修正

### 房产销售过程数据沉淀

- 保持 `active_project`。
- 目标改为：能够区分说话人，并对每次 Open Home、Open Inspection 及房产销售过程实现全程、全量、清晰录音。
- CRM 客户记录与销售回填继续属于该项目的数据入口。
- 当前仍在探索可靠、低干扰的采集和说话人区分方案。
- 本次修正明确取代 V2 中“不承诺所有场景全程、全量录音”的表述；旧版本继续保留在版本历史中，不删除。

### B 线：自媒体生产线

- 新建顶层 `自媒体生产线`，状态为 `active_project`。
- `EP00《挺好》` 保持 `closed`，明确记录为“已经发布”，增加 `part_of → 自媒体生产线`。
- 新建 `40 年超长期房贷`，状态为 `active_project`：内容已经完成并达到可发布状态，但尚未发布；增加 `part_of → 自媒体生产线`。
- 后续明确属于自媒体的口播稿、视频号/短视频内容和内容生产素材，作为 B 线子项目处理；不归入 A 线房产业务。

### Amy / Smart Listing L008

- 将现有 `27 Cecil Street` 规范名称改为 `Amy / Smart Listing L008｜27 Cecil Street 样板`。
- 保持 `active_project`。
- 增加 `part_of → Amy / Smart Listing`。
- 当前目标：用该房源验证空间浏览、Amy 陪看与真实房源资料协作。

## 2. “40 年房贷”证据定位结果

该内容不在此前 2026-08-31—2026-09-24 的初始化窗口内，而是在同一批准群更早的历史中：

- 2026-08-21 08:02:20Z，Ivy 分享 SBS 中文“40 年超长期房贷”选题链接并明确其自媒体地产内容方向；消息 ID：`om_x100b67b42e0a3cb0c3756e6ece67c14`。
- 2026-08-21 16:16:41Z，James 在同一群的回复中给出完成 review 的 40 年房贷口播稿；消息 ID：`om_x100b67b3d05feca4b25037e0475f92c`。

生产只需持久化第一条 Ivy 原始选题消息作为该 active 子项目的可追溯来源；不需要把 2026 年全部 1,956 条历史重新写入数据库。

## 3. 本地实现边界

1. baseline manifest 支持给新增项目声明稳定 `key`，并在同一事务中建立“现有项目 → 新项目”及“新项目 → 新项目”的 `part_of`。
2. Founder 历史回填新增 `--persist-sources-only` 模式：保留批准群、显式时间窗口、90 天原文保留和覆盖审计，但不创建 Codex 分析任务。
3. 语义分类保留明确的自媒体口播稿、视频号/短视频和内容生产素材，不再把它们作为游离 artifact 丢出工作地图。
4. Worker 只在已经存在且处于非 closed 状态的 `自媒体生产线` 下，为有明确自媒体信号的新话题建立 `part_of`；不因普通房源视频、会议视频或 Smart Listing 素材中的单独“视频”二字误归类。

## 4. 精确 manifest

文件：`deploy/founder-work-map-v3-20260924.manifest.json`

生产即时前置预期：

- topics = 31
- perspectives = 21
- relations = 27
- `房产销售过程数据沉淀` current version = 4
- `Amy / Smart Listing` current version = 2
- `27 Cecil Street` current version = 2
- `EP00《挺好》` current version = 1

计划写入：

- 追加 3 个规范版本：销售过程数据沉淀、27 Cecil Street、EP00《挺好》（明确已经发布）。
- 新建 2 个项目：自媒体生产线、40 年超长期房贷。
- 新增 3 条 `part_of`：27 Cecil → Amy；EP00 → 自媒体生产线；40 年房贷 → 自媒体生产线。
- 0 删除、0 `same_as`、0 观点改写、0 群消息发送。

## 5. 生产执行顺序

### D1：即时只读确认

- Bridge healthy，restart count 无新增异常。
- active jobs = 0，pending outbox = 0。
- 群发送开关仍为 false。
- SQLite integrity = `ok`，foreign key violations = 0。
- topic/version/count 与 manifest 完全一致。
- 对 2026-08-21 08:02:20Z—08:02:21Z 执行一次只读 dry-run，必须只捕获目标消息，不写数据库。

任一项不符，停止并重新生成 manifest。

### D2：关闭态备份、证据写入与 baseline

1. 停止 Bridge。
2. 使用 SQLite backup API 生成一致性备份，并核对完整性、外键和关键计数。
3. 使用精确一秒窗口运行 `--persist-sources-only`：
   - chat 只能是批准群 `oc_a84d5b6ca478220d0a37964b50776edb`；
   - 不启动 Worker；
   - 不创建分析任务；
   - 不调用 Codex；
   - 不发送群消息。
4. 验证目标来源 ID 为 `ctxsrc_21d5148d3f1b42b9019a15a3a62c3fac`，原文保留期为 90 天。
5. 运行 V3 baseline `--preview`，预期：canonicalUpdates=3、newTopics=2、partOf=3、sameAs=0、applied=false。
6. 再运行 `--apply`，所有变更在一个事务中完成。

### D3：写后验证与恢复

- integrity = `ok`，foreign key violations = 0。
- topics = 33，perspectives = 21，relations = 30。
- active jobs = 0，pending outbox = 0。
- 旧 topic/version/evidence/perspective 均存在。
- A 线、B 线、合伙人对齐室三条顶层结构正确。
- `27 Cecil Street` 只归属 Amy / Smart Listing；已发布且 closed 的 EP00 与尚未发布且 active 的 40 年超长期房贷只归属自媒体生产线。
- 群发送仍为 false。
- 恢复 Bridge 后检查 health/ready、restart count 和短时稳定性。

## 6. 停止条件

出现以下任一情况，立即停止并保留现场，不自动回滚：

- 精确历史窗口不是唯一目标消息；
- source ID、topic/version 或计数与 manifest 不一致；
- 产生任何分析任务或待发送群消息；
- 备份、完整性或外键检查失败；
- preview/apply 数字与预期不一致；
- 出现多父级、错误 A/B 线归属或原历史对象缺失；
- Bridge 恢复后不健康或出现新增失败任务。
