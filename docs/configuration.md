# 配置

完整配置在 [`.env.example`](../.env.example)。原生部署读取 `.env`；可以用 `ENV_FILE` 指定文件。Compose 使用 `.env` 注入变量，并在容器内覆盖数据库连接地址。

## 必填项

| 配置 | 用途 |
| --- | --- |
| `MYSQL_URL` | 原生部署的 MySQL 连接串；Compose 自动使用内部 `mysql` 服务 |
| `REDIS_URL` | 原生部署的 Redis 连接串；Compose 自动使用内部 `redis` 服务 |
| `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`REDIS_PASSWORD` | Compose 数据服务密码；使用 URL 安全的独立随机值 |
| `V2_SESSION_SECRET` | 管理会话签名 |
| `CREDENTIAL_ENCRYPTION_KEY` | 敏感字段加密；迁移旧库必须保留原值 |
| `VIEWER_ADMIN_PASSWORD` | 管理后台登录口令 |
| `PUBLIC_ORIGIN` | 实际 HTTPS 来源，用于链接生成及来源校验 |

不要将 `.env`、数据库、备份或真实上游响应提交到仓库。随机密钥分别生成；丢失加密密钥后，数据库备份也无法恢复凭证原文。

## 运行参数

| 配置 | 默认值 / 说明 |
| --- | --- |
| `HOST`、`PORT` | 原生默认 `127.0.0.1:8790`；Compose 内部监听 `0.0.0.0` |
| `MYSQL_POOL_SIZE` | 每进程 10；多个 API 与 Worker 的连接总量需一起计算 |
| `REDIS_PREFIX` | `opusmail:`；同一部署的 API 必须一致，不同部署需分开 |
| `TRUST_PROXY` | 仅信任实际反向代理地址或专用网段 |
| `V2_READ_ONLY` | 默认 `false`；维护时锁定业务写入 |
| `V2_SYNC_INTERVAL_MS` | Worker 调度周期，默认 60000 毫秒；不表示全量扫描邮件 |
| `V2_PENDING_MAIL_*` | 待补充邮件的批次、调度与重试间隔 |

主线账号权威固定为原生 V2。模板中的 `V2_ACCOUNT_AUTHORITY` 是历史兼容项，不会把运行模式切回 V1。`DATABASE_PATH` 仅用于旧 SQLite 输入及离线测试；生产模式不使用它存储业务数据。

## 可选接入

| 功能 | 配置 |
| --- | --- |
| 外部账号导入 | `IMPORT_API_KEY`；仅用于导入接口 |
| 共享邮件上游 | `MAIL_API_BASE`、`MAIL_ADMIN_AUTH`；按需读取及待处理补漏 |
| 收件事件推送 | `V2_MAIL_WEBHOOK_SECRET`；使用独立 Bearer 密钥 |
| Outlook 同步 | `OUTLOOK_MANAGER_BASE`、`OUTLOOK_MANAGER_PASSWORD`、`V2_OUTLOOK_MAIL_SYNC_ENABLED` |
| 外部账号服务 | `SUB2API_API_URL` 及对应认证；配置后 Worker 可同步，接入前确认数据范围 |
| 优惠资格检查 | `PAYMENT_EXPOSURE_PROMOTION_PROXY_JP`、`V2_PROMOTION_*`；自动调度另需 `V2_AUTO_TRIAL_ENABLED=true` |
| 支付方式观察 | `PAYMENT_METHOD_EXTRACT_API_BASE`、`PAYMENT_METHOD_EXTRACT_API_KEY`；由单独部署的本机提炼服务执行 |
| 外部检查结果写入 | `PAYMENT_EXPOSURE_API_KEY`，与账号导入密钥分开 |
| 路由邮箱与历史关联 | `ROUTING_*`、`TRUSTED_REBIND_DOMAINS`；按实际收件和绑定规则配置 |

缺少服务配置时，相关功能会显示未配置或返回错误，不会自动接入其他人的服务。容器中的 `127.0.0.1` 是容器自身，接入地址需在实际网络中可达。

`V2_SHARED_MAIL_SYNC_*` 仍保留兼容背景，不代表主线会按这些参数定时扫描整个共享邮箱。`PAYMENT_ELIGIBILITY_API_*` 保留配置读写入口，但当前支付方式观察任务由 `payment-exposure.ts` 调用本机 `/api/extract/jobs`；不要将两者混作同一个调用链。

本机提炼服务默认地址为 `http://127.0.0.1:18794`；配置了地址不表示服务健康。适配器限制为回环主机，Compose 默认不包含该服务，也不能直接访问宿主机回环地址。没有该依赖时保留功能未接入状态，不要为使按钮可用而绕开网络限制或替换既有支付流程。

历史变量不是新项目的集成契约；接入请使用 [API](api.md) 中的当前入口。
