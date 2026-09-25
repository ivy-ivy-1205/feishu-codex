# Founder 工作地图 V5 本地变更单

## 目标

1. 工作地图先展示业务框架，再展示项目和子项目，不再把所有 active topic 铺成同一层。
2. A 线拆出两个客户入口：`AiJia 官网` 与 `Smart Listing`；Amy 作为二者共享的数字员工与服务底座，不再与 Smart Listing 合并成项目名称。
3. `房产销售过程数据沉淀` 明确为三类数据：Open Home 真实销售录音、CRM 客户记录与回填、销售团队内部 Training 录音。
4. B 线项目继续归入 `自媒体生产线`，已结束项目仍保留状态。

## 已有语料依据

- `ctxsrc_8886aef5e82dcf97df835d80ea3a5afa`：一套共享业务系统呈现为官网、Smart Listing 智能房源页、客户专属空间和团队工作台；数字员工是这些界面里的服务角色。
- `ctxsrc_d81a025f0c185b0be5faad8d2a51459a`：官网 workspace 可接入数字员工，并以 session、客户记录和行业知识支撑持续服务。
- 这些来源已存在于批准群的生产来源库；本地 V5 没有扩大飞书读取范围。

## 本地 manifest 预期

- 写前：35 topics、25 perspectives、32 relations。
- 更新4个规范项目版本：A 线总项目、Smart Listing、房产销售过程数据沉淀、L008 样板。
- 新增1个 active 项目：`AiJia 官网`。
- 新增1条 `part_of`：`AiJia 官网` → `AiJia AI Native 房产业务`。
- 写后预期：36 topics、25 perspectives、33 relations；规范项目10个。
- 不删除历史，不改写来源，不创建 outbox，不开启群发送。

## 目标展示结构

```text
A 线｜AiJia AI Native 房产业务
├─ AiJia 官网
├─ Smart Listing
│  └─ Smart Listing L008｜27 Cecil Street 样板
├─ AI 选房经验与知识库
└─ 房产销售过程数据沉淀
   ├─ Open Home 销售过程录音
   ├─ CRM 数据分析与销售回填
   └─ 销售团队内部 Training 录音

B 线｜自媒体生产线
├─ 40 年超长期房贷｜active / 可发布未发布
└─ EP00《挺好》｜closed / 已发布

公司协作基础设施
└─ AiJia Founder Alignment Room / AiJia 合伙人对齐室
```

## 当前边界

- 本文件与 V5 manifest 仅为本地候选；尚未写生产数据库、替换生产镜像或发送飞书消息。
- 生产 apply 前仍需即时确认 topic version、来源、队列、outbox、数据库完整性与群发送开关。
