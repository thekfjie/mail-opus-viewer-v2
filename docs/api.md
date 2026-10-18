# API 接入

本文对应公开 V2 的 `/api/v2` 接口。管理员、外部导入、邮件推送和分享使用不同的认证，调用方应按用途接入。生产地址由部署者配置，下文均使用示例域名。

## 认证

| 调用方 | 认证 | 入口 |
| --- | --- | --- |
| 管理后台 | 登录后签名 Cookie `mail_opus_v2_admin` | `/api/v2/admin/*` |
| 账号生产方 | `X-API-Key: <IMPORT_API_KEY>` | `POST /api/v2/import/accounts` |
| 检查结果生产方 | `X-API-Key: <PAYMENT_EXPOSURE_API_KEY>` | `POST /api/v2/internal/payment-exposure-check` |
| 上游收信服务 | `Authorization: Bearer <V2_MAIL_WEBHOOK_SECRET>` | `POST /api/v2/internal/mail-events` |
| 分享访问者 | 独立快照令牌 | `GET /api/share/snapshot?t=…` |

管理员写操作要求合法来源；调用时携带与 `PUBLIC_ORIGIN` 一致的 `Origin`。外部导入密钥不能读取管理员凭证。未配置的集成返回错误，不会自动使用其他服务或抓取浏览器 Cookie。

## 账号导入

`POST /api/v2/import/accounts`，JSON 请求体为 `{ "accounts": [...] }`，每批最多 200 条。

```json
{
  "accounts": [
    {
      "email": "alex@example.com",
      "accessToken": "DEMO_ACCESS_TOKEN",
      "refreshToken": "DEMO_REFRESH_TOKEN",
      "openaiPassword": "DEMO_PASSWORD",
      "totpSecret": "DEMO_TOTP_SECRET",
      "plan": "free",
      "note": "通过业务系统录入"
    }
  ]
}
```

示例值是占位符，不能用于真实认证。其他字段及含义以 [`ImportAccountInput`](../src/server/repository.ts) 为准。响应包含 `imported`、`created`、`rebound` 和按输入 `index` 标记的 `errors`。这是逐条处理的批次，HTTP 成功不表示每条都成功；调用方只处理失败项，避免重跑整批。

账号合并与换绑仍执行身份检查，不会仅凭同名或邮箱相似把账号强行合并。公开 V2 的管理员直接换绑仍受领域规则约束，不等同于其他版本的任意地址换绑协议。

## 管理员会话与查询

登录：`POST /api/v2/admin/login`，请求 `{ "password": "…" }`。使用响应 Cookie 访问管理接口；`POST /api/v2/admin/logout` 退出。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v2/admin/session` | 当前会话 |
| `GET /api/v2/admin/overview` | 账号数量与运行概况 |
| `GET /api/v2/admin/accounts` | 分页列表；`limit`、`offset`、`search`、`status`、`provider` 等筛选 |
| `GET /api/v2/admin/accounts/:id` | 账号、绑定历史、凭证版本与事件 |
| `PATCH /api/v2/admin/accounts/:id` | 更新备注、标记、渠道等管理属性 |
| `GET /api/v2/admin/accounts/:id/credentials` | 显式读取完整凭证；`no-store` |
| `POST /api/v2/admin/accounts/:id/credentials` | 保存凭证；未提交字段沿用现值，显式空值表示清空相应字段 |
| `POST /api/v2/admin/accounts/:id/rebind` | `{ "email": "alex@example.net" }`；执行现有换绑约束并记录历史 |
| `POST /api/v2/admin/accounts/:id/deactivate` | 管理员明确停用 |
| `GET /api/v2/admin/accounts/:id/recycle-eligibility` | 只读查看回收条件 |
| `POST /api/v2/admin/accounts/:id/recycle` | 确认回收，执行状态与归属校验 |
| `POST /api/v2/admin/accounts/bulk` | 批量管理操作 |
| `GET /api/v2/admin/accounts/:id/grants` | 授权记录 |
| `POST /api/v2/admin/accounts/:id/grants` | 为指定 `bindingId` 创建独立入口 |
| `DELETE /api/v2/admin/accounts/:id/grants/:grantId` | 撤销指定授权 |

完整参数校验位于 [`server.ts`](../src/server/server.ts) 及对应领域函数。旧 `/api/admin/*` 路由由兼容模块维护；新集成使用上述 V2 入口。

## 邮件事件

上游将实际消息投递到 `POST /api/v2/internal/mail-events`，使用独立 Bearer 密钥。建议一次投递完整可处理的消息，减少额外读取：

```json
{
  "id": 12345,
  "created_at": "2026-10-18T08:30:00.000Z",
  "address": "alex@example.com",
  "raw": "From: noreply@example.org\r\nTo: alex@example.com\r\nSubject: Verification code\r\n\r\nYour code is 123456."
}
```

- `id` 是可精确回读的上游正整数消息 ID，必须稳定；不能每次重投生成新 ID。
- `created_at` 使用真实收件时间和明确时区，不使用通知抵达时间代替历史收件时间。
- `raw` 为 MIME 原文。正文用于本次解析，不持久化到本地业务库。
- 缺少可核实收件时间或仅有元数据时，服务会尝试按 ID 向配置的上游补取；失败记录待处理状态，由 Worker 按冷却时间补漏。不能把只有主题且无消息 ID 的通知当成取件契约。

响应包含 `ok`、`messageId`、`inserted`、`claims` 和 `processingStatus`。`processed` 表示完成索引处理；`pending_time` / `pending_parse` 表示已记录待补充，HTTP 200 不表示消息已具备验证码读取条件。已完成消息重复推送返回相同的处理状态，不重复读取正文。

上游收到成功响应后不需要持续重推待处理消息；传输失败时用带退避的有限重试。不要用短间隔全量列表扫描代替事件投递。

### 管理员取件

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v2/admin/accounts/:id/recent-mails` | 读取账号相关邮件索引 |
| `GET /api/v2/admin/accounts/:id/recent-mail-detail` | 按消息 ID 读取一封邮件 |
| `GET /api/v2/admin/accounts/:id/verification-code` | 按绑定区间读取验证码 |
| `GET /api/v2/admin/mail-health` | 索引、待处理与读取预算状态 |

公开 V2 当前这些接口是请求 / 响应式读取，**没有承诺长轮询或向业务调用方推送验证码**。本节 webhook 是上游到 OpusMail 的收件事件。业务端需要等待码时，应限制等待时长、使用退避，并复用查询结果；不要为每个页面组件重复轮询。客户链接由客户授权路由验证，不携带管理员密钥。

## 资格检查任务

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/v2/admin/accounts/:id/trial-check` | 单账号优惠检查 |
| `POST /api/v2/admin/accounts/promotion-check` | `{ "accountIds": [...] }` 批量提交 |
| `POST /api/v2/admin/accounts/promotion-check/status` | `{ "jobIds": [...] }` 一次查询多个任务 |
| `GET /api/v2/admin/accounts/:id/promotion-check/:jobId` | 单任务状态 |
| `POST /api/v2/admin/accounts/:id/promotion-suspicion` | 人工优惠存疑标记 |
| `POST /api/v2/admin/accounts/:id/payment-exposure-check` | 委托本机提炼服务观察所选支付方式 |
| `POST /api/v2/admin/accounts/payment-exposure-check` | 批量支付方式观察 |
| `POST /api/v2/admin/accounts/payment-exposure-check/status` | 批量任务状态 |

提交后保存返回的任务标识，查询状态时批量合并；终态后停止查询。状态读取不应重新创建任务。传输失败、未配置、资格否定和凭证失效分别处理，不将所有错误统一当成无资格。

支付方式观察需要另外部署本机提炼服务，调用链为 `/api/extract/jobs`。当前适配器请求观察支付方式，并传递是否使用单月优惠；服务端不在本仓库内，不能据此承诺外部服务从不创建 Checkout，接入前需核对该服务的实际流程和配置。

外部检查结果通过专用 `POST /api/v2/internal/payment-exposure-check` 写入，可接收单项、数组或 `{ "checks": [...] }`，每批最多 500 项。结果字段参见 [`PaymentExposureIngestInput`](../src/server/repository.ts)。这个写入入口只接收观察结果，不发起支付。

## 分享与健康检查

分享创建、列表、撤销使用 `/api/v2/admin/share/links`；读取快照使用 `GET /api/share/snapshot?t=…`。令牌受有效期与访问次数限制，快照不会包含 AT、RT、代理凭证或内部检查地址。

`GET /health` 是存活检查；`GET /ready` 验证 MySQL 与 Redis 可用性；`GET /api/v2/version` 返回构建清单。健康检查不用于判断全部外部服务是否可用。

## 错误处理

常见状态：`400` 输入或业务约束不满足，`401` 未认证，`403` 来源或写入权限不允许，`410` 分享失效，`429` 超出请求预算，`503` 依赖或集成未就绪。响应通常包含 `error`；具体业务批次还可能在成功响应中返回逐项错误。

Redis 故障不会静默切换为各进程独立限流。遇到 `429` / `503` 时降低频率并按用途重试，不重新跑已经成功的整批操作。
