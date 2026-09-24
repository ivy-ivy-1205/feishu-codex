# Founder 工作地图 V2 生产基线变更单

日期：2026-09-24  
状态：结构已由 Ivy 确认；生产写入尚未执行

## 1. 目标与边界

把生产库现有 27 个模型生成话题整理成 6 个经 Ivy 确认的规范项目，同时保留所有原始话题、版本、证据和观点历史。

- 不删除话题、版本、证据、来源或观点。
- 不读取新的飞书数据，不调用 Codex，不发送群消息。
- 群发送继续关闭。
- 只在一致性备份完成、Bridge 停止且活动任务为 0 时写入。
- 异常时先停止并保留现场，不自动回滚；恢复备份需要 Ivy 再确认。

## 2. 已确认的规范结构

### 公司级

1. `AiJia Founder Alignment Room / AiJia 合伙人对齐室` — `active_project`

### A 线：AiJia AI Native 房产业务

2. `AiJia AI Native 房产业务` — `active_project`
3. `Amy / Smart Listing` — `active_project`，`part_of` A 线
4. `AI 选房经验与知识库` — `active_project`，`part_of` A 线
5. `房产销售过程数据沉淀` — `active_project`，`part_of` A 线

`情绪价值`作为 A 线贯穿原则保存在母项目 rationale/supporting item 中，不创建独立项目。

### B 线：自媒体业务

6. `EP00《挺好》` — `closed`，不属于 A 线

## 3. 现有 27 个话题的精确归并

| 规范项目 | 现有数量 | 规范代表 | 写入动作 |
|---|---:|---|---|
| AiJia AI Native 房产业务 | 6 | `topic_0622155dc9cfbc4ae20c295b04312e99` | 追加规范版本；其余 5 个添加 `same_as` |
| Amy / Smart Listing | 8 | `topic_5606ca3835bf19372aff6ff4e39bb75d` | 追加规范版本；其余 7 个添加 `same_as`；添加 `part_of` |
| AI 选房经验与知识库 | 4 | `topic_1cc3409beb2d46176ecfbb76c440641f` | 追加规范版本；其余 3 个添加 `same_as`；添加 `part_of` |
| 房产销售过程数据沉淀 | 3 | `topic_4d3df2c0792480acf4913b2fea8e42de` | 追加规范版本并移除“全量录音”承诺；其余 2 个添加 `same_as`；添加 `part_of` |
| AiJia 合伙人对齐室 | 6 | `topic_106cf9757e6cae55cbca67fa5e677cd7` | 追加规范版本；其余 5 个添加 `same_as` |
| EP00《挺好》 | 0 | 新建 | 新建 `closed` 项目，关联已持久化 EP00 文件来源 |

合计：27 个现有话题全部被覆盖；新增 1 个 EP00 规范话题；新增 22 条 `same_as`、3 条 `part_of`。

## 4. 规范项目内容

### AiJia AI Native 房产业务

- 类型：A 线总项目。
- `AI Native 房产业务`与`AI Native 房产服务`视为同一个项目。
- `情绪价值`是贯穿产品、内容、客户体验和服务流程的原则，不单独立项。

### Amy / Smart Listing

- Amy 持续服务客户，并按需要调用专业能力。
- 与 AI 选房项目共用底层知识库/数据库。

### AI 选房经验与知识库

- 合并`选房经验提炼与资料准备`和`把你和我的实际经验加入 AI 选房流程`。
- Ivy 综合 James/Jimmy 的销售经验和选房判断方法，进行分析、提炼，形成 AiJia 选房知识库。
- 当前待补：Jimmy 的判断语录。

### 房产销售过程数据沉淀

- 覆盖每次 Open Home 的语音采集，以及每次 Open Inspection/销售过程中的 CRM 客户记录和销售回填。
- 不承诺所有场景全程、全量录音；目标是保证关键销售活动有可沉淀的数据入口。

### AiJia 合伙人对齐室

- 在创业阶段项目不断变化时，让 Ivy 与 James 对同一场景、目标、方向和完成标准保持高度统一。
- 及时暴露理解偏差，减少反复解释、查找、返工和额外人工沟通。

### EP00《挺好》

- B 线自媒体项目。
- 已完成，状态为 `closed`，无后续行动。

## 5. 观点保留策略

生产当前有 18 条 current perspective，分散在重复话题上。

- 原 perspective 和历史版本全部保留，不改写、不删除。
- 规范地图读取时沿 `same_as` 连通分量汇总观点，不能只读取规范代表 ID。
- 同一创始人、同一 decision key 出现重复表达时，展示最新有证据的一条；不同 decision key 继续并列。
- “全量录音”只保留为历史 James proposal，不作为当前共同决定；规范项目边界采用 Ivy 已确认的“关键活动多入口沉淀”。
- 未经双方明确确认，不自动生成 `shared_decision`。

该读取能力必须先在本地以测试覆盖，再写生产基线，避免结构归并后地图暂时丢失历史观点。

## 6. 实施顺序

### D0：本地实现与验证

1. 增加 `same_as` 连通分量的观点聚合读取。
2. 增加一次性 V2 baseline CLI：只接受精确 manifest、预期 topic/version 和 `--preview`/`--apply`。
3. `--preview` 输出仅包含计数、规范名称、关系数量和冲突，不输出正文、身份或凭据。
4. 单事务写入；任何 topic/version 漂移、证据缺失或关系冲突均整体失败。
5. 全量测试、typecheck、build、diff check 通过并建立审计 checkpoint。

### D1：生产即时只读确认

- Bridge `running/healthy`，restart 0。
- topic=27、perspective=18、现有 relation=0。
- active jobs=0、pending outbox=0、SQLite integrity=`ok`。
- 三个 Founder 开关保持现状，群发送必须为 false。

任一基线变化则停止，重新生成 manifest，不强行套用旧版本号。

### D2：关闭态备份与写入

1. 停止 Bridge。
2. 用 SQLite backup API 生成一致性备份：`/opt/feishu-codex/backups/bridge.pre-founder-baseline-<UTC>.sqlite`。
3. 对备份执行完整性、外键、topic/perspective/outbox 计数核对。
4. 先运行 baseline `--preview`；结果必须为：更新 5 个规范代表、新建 1 个 EP00、22 个 `same_as`、3 个 `part_of`、0 删除、0 冲突。
5. 再运行 `--apply`，单事务提交。

### D3：写后验证与恢复服务

- SQLite integrity=`ok`、foreign key violations=0。
- 原 27 个 topic、所有历史 version/evidence/perspective 仍存在；新增 EP00 后 topic=28。
- canonical projection 恰好显示 6 个规范项目。
- `same_as`=22、`part_of`=3。
- A/B 线与公司级层级正确。
- 18 条原 current perspective 均可经规范地图访问。
- active jobs=0、pending outbox=0、群发送仍关闭。
- 启动原 Bridge，验证 health/ready、restart count 和短时稳定性。

## 7. 停止条件

出现以下任一情况，立即停止并保留现场，不自动回滚：

- topic/version 与 manifest 不一致；
- 活动任务或待发送消息非 0；
- 备份、完整性或外键检查失败；
- 写入计数不是 5 次规范版本、1 个新项目、22 个 `same_as`、3 个 `part_of`；
- 任何原始 topic/version/evidence/perspective 消失；
- canonical projection 不是 6 个项目，或观点不可达；
- Bridge 恢复后 health/ready 异常或出现新增失败任务。

## 8. 本次不包含

- 不开启群内自动发送。
- 不重新读取 20 天历史或附件。
- 不调用 Codex 重新总结。
- 不把“尚未回复”推断成分歧。
- 不自动执行任何 Todo。
