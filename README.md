# Opus Mail V2

Opus Mail V2 是面向账号运营团队的管理后台，用于统一处理账号生命周期、邮箱绑定、凭证版本、邮件检索、资格检测和运营审计。项目将身份、邮箱与凭证分别建模，通过明确的状态转换和审计记录降低批量运营中的误关联风险。

## 核心能力

### 账号与凭证管理

- 按账号状态、套餐、渠道、凭证状态、交付状态和自定义标记进行检索与批量操作。
- 管理邮箱换绑、账号停用、账号回收、凭证更新及身份冲突审查。
- 保存 OAuth 凭证版本，支持批量预览、确认写入、完整导出和健康检查。
- 对重复身份、模糊归属和异常状态采用保守关联策略，并交由人工复核。

### 邮件与运营工具

- 从共享邮件服务和 Outlook 类服务同步邮件，提供管理员邮件列表、详情和验证码检索。
- 管理 Outlook Free 账号池、账号导入、邮箱转移及 Session 数据导入。
- 创建可撤销、可过期并带访问次数限制的只读分享快照。
- 执行促销资格与支付方式资格检查，并记录结构化结果和任务状态。
- 提供使用情况审计、事件时间线、迁移报告和生产状态检查。

### 集成与可靠性

- 同步外部账号平台中的有效凭证和账号状态。
- 通过受保护的 API 批量导入账号或接收检查结果。
- 使用 SQLite 持久化数据，并提供完整性校验、在线备份和构建清单校验。
- 支持只读模式、兼容权威模式与原生独立模式，便于渐进部署。

## 产品边界

本仓库交付管理员后台、管理 API、客户邮箱页面和后台 Worker。旧客户链接及兼容邮件 API 由 V2 本地实现，并继续在管理员鉴权、客户授权和公开读取之间保持严格边界。

## 安全设计

- 访问令牌、刷新令牌、ID Token、Session Token 和业务密码使用 AES-256-GCM 加密保存。
- 管理接口要求已登录会话；写操作同时校验同源请求，并设置速率限制。
- 管理员敏感信息读取接口返回 `Cache-Control: no-store`，公开快照不包含管理凭证和内部地址。
- 健康检查、审计事件和应用日志仅记录状态或不可逆指纹，不记录完整凭证。
- 生产环境支持写保护、发布清单校验、SQLite 一致性检查及滚动备份。

## 技术栈

- Node.js 20.19+
- TypeScript、Fastify
- React、Vite
- SQLite、`better-sqlite3`
- Node.js Test Runner

## 快速开始

```bash
git clone https://github.com/thekfjie/mail-opus-viewer-v2.git
cd mail-opus-viewer-v2
npm ci --include=dev
cp .env.example .env
```

生成独立的会话密钥和凭证加密密钥，并在 `.env` 中设置管理口令：

```bash
openssl rand -base64 48
```

```dotenv
SESSION_SECRET=<session-secret>
CREDENTIAL_ENCRYPTION_KEY=<credential-encryption-key>
VIEWER_ADMIN_PASSWORD=<admin-password>
```

启动开发服务：

```bash
npm run dev
```

服务默认监听 `http://127.0.0.1:8790`。状态检查：

```bash
curl --fail http://127.0.0.1:8790/health
```

## 配置

完整模板见 [`.env.example`](.env.example)。以下为主要配置项：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | HTTP 监听端口 | `8790` |
| `DATABASE_PATH` | SQLite 数据库路径 | `/var/lib/mail-opus-v2/mail-opus-v2.sqlite` |
| `PUBLIC_ORIGIN` | 管理后台对外地址 | `https://mail.example.com` |
| `SESSION_SECRET` | 管理会话签名密钥 | 无 |
| `CREDENTIAL_ENCRYPTION_KEY` | 敏感业务字段加密密钥 | 无 |
| `VIEWER_ADMIN_PASSWORD` | 管理后台登录口令 | 无 |
| `V2_READ_ONLY` | 是否锁定原生写操作 | `false` |
| `V2_ACCOUNT_AUTHORITY` | 账号写入权威模式：`v1` 或 `v2` | `v2` |
| `V2_SYNC_INTERVAL_MS` | 后台同步间隔，单位为毫秒 | `60000` |
| `V2_SHARED_MAIL_SYNC_ENABLED` | 是否启用共享邮件同步 | `false` |
| `V2_OUTLOOK_MAIL_SYNC_ENABLED` | 是否启用 Outlook 邮件同步 | `false` |
| `V2_AUTO_TRIAL_ENABLED` | 是否启用自动促销资格检查 | `false` |

外部服务按需配置：

| 变量 | 说明 |
| --- | --- |
| `MAIL_API_BASE`、`MAIL_ADMIN_AUTH` | 共享邮件服务地址及认证信息 |
| `OUTLOOK_MANAGER_BASE`、`OUTLOOK_MANAGER_PASSWORD` | Outlook 类邮件管理服务配置 |
| `SUB2API_API_URL`、`SUB2API_ADMIN_TOKEN` | 外部账号平台地址及访问令牌 |
| `PAYMENT_ELIGIBILITY_API_URL`、`PAYMENT_ELIGIBILITY_API_TOKEN` | 支付资格检查接口及访问令牌 |
| `PAYMENT_EXPOSURE_PROXY_*` | 按检查区域配置的服务端代理 |
| `ROUTING_*` | 不参与账号关联的路由邮箱配置 |
| `TRUSTED_REBIND_DOMAINS` | 允许自动识别换绑的可信域列表 |

生产环境必须显式设置会话密钥、加密密钥和管理口令。不同用途的密钥不得复用，也不得提交 `.env`、数据库、备份文件或真实凭证。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务并监听源码变化 |
| `npm test` | 运行完整测试套件 |
| `npm run build` | 构建服务端和前端产物 |
| `npm start` | 启动已构建的 API 与 Web 服务 |
| `npm run worker` | 启动邮件同步和后台任务 Worker |
| `npm run backup` | 创建并验证 SQLite 在线备份 |
| `npm run audit` | 执行生产数据一致性审计 |

构建输出位于 `dist/`。`dist/release-manifest.json` 记录源码提交、构建时间、前端入口和产物哈希；生产服务启动前会校验该清单。

## 部署

`deploy/` 提供 systemd 服务、备份定时器、Nginx 模板和发布脚本。示例默认使用 `/opt/mail-opus-viewer-v2` 作为应用目录，部署前应按实际环境调整域名、证书路径和外部服务配置。

```bash
npm ci --include=dev
npm run build

sudo cp deploy/mail-opus-viewer-v2.service /etc/systemd/system/
sudo cp deploy/mail-opus-viewer-v2-worker.service /etc/systemd/system/
sudo cp deploy/mail-opus-viewer-v2-backup.service /etc/systemd/system/
sudo cp deploy/mail-opus-viewer-v2-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
  mail-opus-viewer-v2.service \
  mail-opus-viewer-v2-worker.service \
  mail-opus-viewer-v2-backup.timer
```

后续发布可执行：

```bash
git pull --ff-only
./deploy/release.sh
```

备份任务会依次执行源数据库完整性检查、SQLite 在线备份、备份文件完整性检查和外键检查。默认每 6 小时运行一次，并保留最近 45 份备份；可通过 `V2_BACKUP_DIRECTORY` 和 `V2_BACKUP_RETENTION` 调整。

## API 概览

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 服务状态、运行模式和发布信息 |
| `GET /api/v2/version` | 当前发布清单 |
| `/api/v2/admin/*` | 管理会话、账号、凭证、邮件与运营工具 |
| `GET /api/share/snapshot` | 访问受限的只读分享快照 |
| `POST /api/v2/import/accounts` | 使用 `X-API-Key` 导入账号 |
| `POST /api/v2/internal/payment-exposure-check` | 写入结构化支付检查结果 |

## 目录结构

```text
src/server/   API、数据库、同步任务和领域逻辑
src/shared/   前后端共享类型
web/src/      React 管理后台
tests/        领域规则、同步、写入流程和安全测试
scripts/      生产审计、构建清单及检查桥接脚本
deploy/       systemd、Nginx 和发布配置
```

## 安全

请勿在公开 Issue 中提交真实凭证、邮箱数据或内部服务地址。安全问题请通过 GitHub Security Advisories 私下报告，详见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
