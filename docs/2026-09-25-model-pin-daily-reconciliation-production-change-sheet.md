# AiJia 合伙人对齐室：模型锁定与每日防漏复核生产变更单

状态：**待 Ivy review；不构成生产执行授权。**

目标提交：`2b97c81`。该提交包含每日 24 小时防漏复核提交 `bed01df`，以及模型锁定、测试、配置示例和群置顶说明。

## 1. 本次唯一目标

用一次 Bridge 替换完成两项变更：

1. 所有 Bridge 内的 Codex CLI 语义任务显式使用 `gpt-5.6-sol` + `medium`，不再跟随账号默认模型漂移；
2. 对唯一批准群每天执行一次最近 24 小时的飞书历史复核，只把此前未持久化的新来源送入既有分析链路。

本次不启用自动分歧提醒，不启用自动工作地图推送，不修改 Nginx、域名、飞书权限、OAuth、身份映射、数据库 schema 或其他产品。

## 2. 精确配置差异

生产 `bridge.env` 只新增或改为以下值：

```text
CODEX_MODEL=gpt-5.6-sol
CODEX_REASONING_EFFORT=medium
FOUNDER_STREAM_DAILY_RECONCILIATION_ENABLED=true
```

下列现有边界必须保持：

```text
WORKER_ENABLED=true
FOUNDER_STREAM_CAPTURE_ENABLED=true
FOUNDER_STREAM_ANALYSIS_ENABLED=true
FOUNDER_STREAM_MANUAL_QUERY_ENABLED=true
FOUNDER_STREAM_GROUP_DELIVERY_ENABLED=false
PROJECT_CONTEXT_CHAT_IDS=oc_a84d5b6ca478220d0a37964b50776edb
```

不得增加 `OPENAI_API_KEY`、API fallback 或其他模型供应商凭据。模型不可用、ChatGPT 登录失效或 CLI 返回非零时必须失败并保留诊断，不得静默更换模型。

## 3. 已完成的本地门禁

- TDD 红灯确认旧代码未传模型和推理强度；绿灯后每次 `codex exec` 显式传入 `--model gpt-5.6-sol` 与 `model_reasoning_effort="medium"`。
- 配置只接受 GPT-5.6 Sol/Terra/Luna 和官方支持的推理强度闭集；`account-default`、`automatic` 等值拒绝启动。
- 每日复核只允许唯一批准群；使用稳定来源标识去重，仅新增来源进入分析。
- 群查询卡显示最后收到、最后分析、最后防漏复核、积压、未补偿失败和唯一缺口数。
- `93` 个测试文件、`796` 项测试、typecheck、build、diff check 全部通过。

## 4. 执行顺序

### D1：即时只读确认

不修改服务器，只确认：

- 当前 Bridge 的 image/revision、运行状态、restart count、`/health`、`/ready`；
- SQLite 实际路径、`integrity_check`、活动 Founder jobs、pending outbox、最后收到和最后分析时间；
- `codex --version`、`codex login status` 必须仍为 ChatGPT 登录；
- 不打印值，只确认 OpenAI API 环境变量仍为 unset；
- 当前六个 Founder 开关、唯一批准群、磁盘空间和 Docker 构建缓存；
- `gpt-5.6-sol` 与 `medium` 仍出现在该账号/CLI 可用模型元数据中，不发起额外模型调用。

任一前置条件不满足则停止，不构建、不改配置、不重启。

### D2：隔离构建候选镜像

- 从 tracked-only 的目标提交 `2b97c81` 生成归档，记录 SHA-256；
- 在 `/opt/feishu-codex` 的隔离 build/upload 目录构建候选镜像；
- 镜像标签和 OCI revision 必须为 `2b97c81`；
- 用不挂生产数据库、不连飞书、不调用 Codex 的临时容器验证配置解析、编译产物和目标 CLI 文件存在；验证容器立即删除；
- 生产 Bridge 继续运行，不在 D2 重启。

### D3：一次关闭态切换

1. 再次确认没有正在执行的生产任务；如有活动任务，等待其完成并重新确认，不强杀模型任务。
2. 停止 Bridge，保留现场。
3. 对生产 SQLite 做一致性备份，权限 `600`，验证 `integrity_check=ok`；备份当前 env、应用 checkpoint、当前镜像 ID/revision。
4. 只写入第 2 节的三个配置值；再次确认 `GROUP_DELIVERY=false`。
5. 用候选镜像替换 Bridge 并启动一次。不得在本变更中做第二次试探性重启。

首次启动时，如果数据库中没有最近 24 小时的 coverage audit，每日复核会在首个 worker tick 立即运行；以后以上次成功记录为基准，每 24 小时运行一次。

### D4：部署后验证

- Bridge `running/healthy`、restart count 符合一次切换，`/health` 与 `/ready` 成功；
- 运行镜像 revision 为 `2b97c81`；
- 三个新配置值准确，既有六个 Founder 边界未改变；
- ChatGPT 登录有效，API Key 环境变量仍未设置；
- SQLite `integrity_check=ok`，身份映射仍为两位已配置 founder；
- 首次 24 小时复核产生新的 coverage audit，或明确报告安全 gap；重复消息不新增重复 source；
- 如发现新来源，只允许形成持久化分析 job；`GROUP_DELIVERY=false` 下不得产生自动群提醒或工作地图投递；
- 手动查询能力仍可用，但本次不主动在群里发送测试消息；Ivy/James 后续自然使用三条查询指令验收。

## 5. 异常处理与回滚边界

出现以下任一情况，先停止 Bridge、保留数据库和日志现场并报告，**不自动回滚**：

- health/ready 失败；
- SQLite integrity 异常；
- ChatGPT 登录失效或模型不可用；
- 每日复核读取了非批准群；
- 自动群消息或非预期 pending outbox 出现；
- 相同来源重复创建、队列持续增长或同类任务连续失败；
- 模型参数没有被显式传入，或发生隐式模型 fallback。

只有 Ivy 明确批准后才执行回滚。代码回滚优先恢复旧镜像和旧 env；本次没有 schema migration，正常情况下不恢复数据库。只有确认数据库发生不可接受写入且 Ivy 单独批准时，才使用本次一致性备份恢复。

## 6. 清理范围

部署验证通过后，可删除本次 `2b97c81` 的上传归档、隔离 build 目录和无容器引用的临时候选标签；保留：

- 当前运行镜像；
- 部署前回滚镜像；
- 本次 SQLite 一致性备份；
- env checkpoint 与部署审计信息。

不清理历史数据库备份、不清理其他产品镜像或目录。

## 7. 生产影响

- 一次短暂 Bridge 停机窗口；期间飞书可能重试 webhook，幂等键负责去重。
- `medium` 相比 `low` 可能增加分析时间和 Codex 套餐额度消耗，但不增加 OpenAI API Key 按量费用。
- 每日复核会增加一次飞书历史读取；只有补到新来源时才增加后续 Codex 分析。
- 群内自动发言仍关闭，因此这次上线不会主动打扰 Ivy/James。

## 8. 审批范围

Ivy 批准本变更单即授权：D1 只读确认、D2 隔离构建、D3 一次关闭态备份与切换、D4 验证，以及验证成功后的第 6 节精确临时资产清理。任何超出本文件的权限修改、第二次重启、自动群投递、数据库恢复或其他产品操作都不在授权范围内。
