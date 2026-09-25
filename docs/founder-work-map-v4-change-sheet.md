# Founder 工作地图 V4 生产变更单

## 目标

1. 用两条人工确认的 `same_as` 关系，把两个持续增量误分类并回正确项目；不删除历史，不改写规范项目版本。
2. 展示层只把有效 `shared_decision` 标为“当前共识”；项目版本之前的个人观点标为“历史提议”，之后的新个人观点或显式分歧标为“待对齐”。同一人、同一时间且正文互为短前缀复述的观点合并证据。
3. 增加生产工作地图 publisher：默认只读预览；手动入队必须同时满足批准群、精确目标确认、预期规范项目数量和生产发送开关。
4. 本轮只运行只读预览，群发送保持关闭，不创建待发送工作地图。

## 精确数据变更

- 预期写前：35 topics、25 perspectives、30 relations。
- 新增 `same_as`：
  - `topic_4cffb20d7cead310bddb2236475c028d` → `topic_0622155dc9cfbc4ae20c295b04312e99`（A 线服务原则）。
  - `topic_a8b0301b2e1362d40b6e6ad741b1a06b` → `topic_03f66a09b3b00d736bf0cab9b4a9e722`（40 年超长期房贷内容证据）。
- 预期写后：35 topics、25 perspectives、32 relations；26 `same_as`、6 `part_of`；规范项目从 11 个变为 9 个。
- 规范项目名称、状态、当前方向和版本不变；观点历史记录不删除、不覆盖。

## 执行门禁

1. 即时只读确认 Bridge healthy/restart 0、group delivery=false、active jobs=0、pending outbox=0、数据库完整性正常，并精确核对 manifest 中 4 个 topic 的 ID/version/name/status/outcome。
2. 本地完整测试、typecheck、build、diff check 通过。
3. 候选镜像构建后先在一致性数据库副本上执行 baseline preview、apply 和 publisher preview。
4. 生产关闭态建立 SQLite 一致性备份，确认完整性后执行一次 baseline apply。
5. 部署候选镜像，恢复 Bridge；再次确认 delivery=false、无 pending outbox。
6. 用生产数据库只读模式生成 V4 预览；不调用 Codex、不访问飞书、不写数据库、不发送群消息。

## 停止与回滚边界

- 任一预期计数、topic version、数据库完整性、健康状态或目标群门禁不匹配：立即停止，保留现场，不自动回滚。
- 本轮不会开启群发送，也不会运行 publisher 的 `--enqueue`。
- 回滚资产包括关闭态 SQLite 备份、旧镜像标签与旧 app checkpoint；是否回滚由 Ivy 另行决定。
