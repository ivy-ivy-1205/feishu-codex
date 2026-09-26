# Founder Work Map V7 生产修正记录

## 修正原因

V6 最终预览把“企业微信接入”错误显示为“飞书合伙人对齐”的子项目。Ivy 的明确要求是：二者均属于 C 线“公司协作基础设施”，并且是并列项目；“飞书第一阶段目标”只归属于 #8。

## 已执行变更

- 新建隐藏的 C 线根节点“公司协作基础设施”。
- 将 #8 重命名为“飞书合伙人对齐”，挂到 C 线。
- 删除“企业微信接入 → 飞书合伙人对齐”的旧 `part_of`。
- 将 #9“企业微信接入”直接挂到 C 线。
- 保留“飞书第一阶段目标 → 飞书合伙人对齐”。

## 生产结果

- revision：`25b2269306e72e5cc212da3a5de22891d9027f7f`。
- 备份：`/opt/feishu-codex/backups/bridge-pre-v7-20260926T105211Z.sqlite`，mode 600，integrity ok。
- baseline preview/apply：canonicalUpdates=1、partOf=2、removedPartOf=1、newTopics=1。
- 终态：41 topics、34 perspectives、38 relations、active jobs=0、pending outbox=0、外键异常=0。
- Bridge running/healthy、restart=0；群投递保持 false。
- 最终只读预览：`foundermap_e1705f7fa81855f8492a759c26dd655c`；未发送飞书群。
