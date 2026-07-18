# 腾讯云服务器只读 Preflight

日期：2026-07-18  
SSH 别名：`aijia-tencent`  
检查性质：只读；未使用 sudo，未安装、修改、重启或部署

## 结论

该服务器可作为候选部署机，但当前不满足部署条件。主要缺口是 Node.js、npm、Codex CLI 与 Codex 登录；同时现有服务和公网入口较多，需要先确认反向代理/Cloudflare 拓扑与端口分配。当前账号无 Docker socket 权限，无法完整审计已有容器。

## 环境

| 项目 | 结果 |
| --- | --- |
| SSH 用户 | `hermes-user`，非 root |
| OS | OpenCloudOS 9.4，Linux x86_64 |
| CPU | 2 vCPU |
| 内存 | 3.6 GiB，总可用约 1.0 GiB；Swap 8 GiB，已用约 2.2 GiB |
| 根盘 | 60 GiB，已用 41 GiB，剩余约 20 GiB（68%） |
| 时区/时间 | `+08:00`，chronyd 运行中 |
| Docker | 29.2.1 |
| Docker Compose | v5.0.2 |
| Git | 2.43.7 |
| Node.js/npm | 未找到 |
| Codex CLI | 未找到，无法检查登录 |
| Nginx/Caddy | 命令或配置对当前用户不可见/不存在 |

## 现有运行状态

- Docker 与 containerd 服务正在运行，但 `hermes-user` 无权访问 `/var/run/docker.sock`，`docker ps` 被拒绝。
- `openclaw.service` 正在运行。
- 检测到 `cloudflared` 进程相关监听。
- 公网监听包含 22、80、443、2096、8002、8443；另有多个仅回环监听端口。
- 因缺少容器权限和代理配置读取权限，无法把端口可靠映射到现有业务，不能直接选择新服务端口。

## 最小补充清单

1. 由 Ivy 或服务器管理员提供现有容器清单与 80/443/Cloudflare 路由说明，或授予一次受控只读容器审计方式。
2. 确认是否允许安装/提供 Node.js 20+ 和固定版本 Codex CLI。
3. Ivy 在服务器上完成 Codex ChatGPT 交互式登录；仅执行 `codex login status` 验证，不读取认证文件。
4. 确认应用数据目录、备份位置和至少数 GiB 的空间预算。
5. 评估 2 vCPU/3.6 GiB 与现有 OpenClaw 共存风险；历史回填与 Codex 应限制并发为 1。
6. 确认域名、TLS 终止点和 Webhook 路由，不修改现有 80/443 服务。

## 部署影响判断

- 资源余量偏紧，历史回填、文件解析和 Codex 不应并行高并发运行。
- MVP 应使用 Docker restart policy，不引入 PM2。
- SQLite 数据目录必须挂载持久化卷并独立备份。
- 在现有端口和代理所有者明确前，部署 Gate 保持关闭。

