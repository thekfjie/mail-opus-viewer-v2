# Opus Mail V2

Opus Mail V2 是面向账号运营场景的邮箱授权与生命周期管理服务。系统将账号身份、邮箱绑定、客户授权和邮件可见范围建模为独立实体，并提供管理后台、客户邮件查看页及外部系统集成接口。

## 功能概览

### 账号管理

- 按生命周期、套餐、渠道、凭证状态、交付状态和自定义标记检索账号。
- 记录邮箱换绑、账号停用、账号回收、客户授权及身份审查事件。
- 支持批量标记、凭证导出、客户交付信息导出和支付方式检查。
- 对身份冲突、重复归属和无法自动关联的数据进入人工审查流程。

### 邮件授权

- 支持账号密码和授权链接两种客户访问方式。
- 按邮箱绑定阶段、授权范围和有效时间窗口隔离邮件。
- 支持共享邮件 API 与 Outlook 类邮件服务接入。
- 对路由地址、账单邮件和归属冲突邮件执行服务端过滤。

### 数据集成

- 同步外部账号平台中的有效凭证和账号状态。
- 通过受保护的内部 API 批量导入账号。
- 接收结构化的支付方式与促销资格检查结果。
- 支持按凭证首次发现时间调度自动资格检查，并对失败任务执行受控重试。
- 使用 SQLite 持久化数据，并提供经过完整性校验的在线备份。

## 设计原则

- **身份与邮箱分离**：稳定账号身份与可变邮箱绑定分别存储。
- **授权范围明确**：客户授权必须关联到具体账号、绑定阶段和时间范围。
- **状态转换可追溯**：停用、换绑、回收和审查处理均写入事件时间线。
- **敏感字段加密**：访问令牌、刷新令牌、ID Token 和业务密码使用 AES-256-GCM 加密保存。
- **最小化信息暴露**：客户接口不返回真实路由地址、邮箱密码或其他账号的受限邮件。
- **保守关联**：只有证据唯一且不存在身份冲突时才自动建立账号关系。

## 技术栈

- Node.js 20.19+ 或 22.12+
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

生成独立的会话密钥和凭证加密密钥，并在 `.env` 中配置管理口令：

```bash
openssl rand -base64 48
```

```dotenv
V2_SESSION_SECRET=<session-secret>
CREDENTIAL_ENCRYPTION_KEY=<credential-encryption-key>
VIEWER_ADMIN_PASSWORD=<admin-password>
```

启动开发服务：

```bash
npm run dev
```

服务默认监听 `http://127.0.0.1:8790`，可通过以下命令检查状态：

```bash
curl --fail http://127.0.0.1:8790/health
```

## 配置

完整配置模板见 [`.env.example`](.env.example)。

### 基础配置

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | HTTP 监听端口 | `8790` |
| `DATABASE_PATH` | SQLite 数据库路径 | `/var/lib/mail-opus-v2/mail-opus-v2.sqlite` |
| `PUBLIC_ORIGIN` | 对外访问地址，用于生成客户授权链接 | `http://127.0.0.1:8790` |
| `V2_SESSION_SECRET` | 管理员与客户会话签名密钥 | 无 |
| `CREDENTIAL_ENCRYPTION_KEY` | 敏感业务字段加密密钥 | 无 |
| `VIEWER_ADMIN_PASSWORD` | 管理后台登录口令 | 无 |
| `V2_READ_ONLY` | 是否启用写保护 | `true` |
| `V2_SYNC_INTERVAL_MS` | 后台同步间隔，单位为毫秒 | `60000` |
| `V2_AUTO_TRIAL_ENABLED` | 是否启用自动资格检查 | `true` |
| `V2_AUTO_TRIAL_DELAY_MS` | 新凭证首次检查前的等待时间 | `43200000` |
| `V2_AUTO_TRIAL_RETRY_MS` | 检查失败后的重试间隔 | `21600000` |
| `V2_AUTO_TRIAL_BATCH_SIZE` | 单轮检查的最大任务数 | `10` |

### 外部服务

| 变量 | 说明 |
| --- | --- |
| `MAIL_API_BASE`、`MAIL_ADMIN_AUTH` | 共享邮件服务地址及认证信息 |
| `OUTLOOK_MANAGER_BASE`、`OUTLOOK_MANAGER_PASSWORD` | Outlook 类邮件管理服务配置 |
| `SUB2API_API_URL`、`SUB2API_ADMIN_TOKEN` | 外部账号平台地址及访问令牌 |
| `AUTOMYAI_EXTRACT_API_BASE`、`AUTOMYAI_EXTRACT_API_KEY` | 支付检查服务地址及认证信息 |
| `PAYMENT_EXPOSURE_API_KEY` | 支付检查结果写入密钥 |
| `PAYMENT_EXPOSURE_PROXY_*` | 按地区配置的服务端代理 |
| `ROUTING_EMAILS` | 不参与账号关联的路由邮箱列表 |
| `TRUSTED_REBIND_DOMAINS` | 允许自动识别换绑的可信域列表 |

生产环境必须显式设置会话密钥、加密密钥和管理口令。不同用途的密钥不得复用，也不得提交 `.env`、数据库、备份文件或真实凭证。

`V2_READ_ONLY=true` 时，账号修改、换绑、停用、回收、授权和导入接口返回 `409`；查询、客户邮件访问和诊断操作仍可使用。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务并监听源码变化 |
| `npm test` | 运行完整测试套件 |
| `npm run build` | 构建服务端和前端产物 |
| `npm start` | 启动已构建的 API 与 Web 服务 |
| `npm run worker` | 启动后台同步任务 |
| `npm run backup` | 创建并验证 SQLite 在线备份 |
| `npm run migrate:v1` | 可选：从兼容格式初始化数据 |

构建输出位于 `dist/`。`dist/release-manifest.json` 记录源码提交、构建时间、前端入口和产物哈希；生产服务启动前会自动校验该清单。

## 生产部署

`deploy/` 提供 systemd 服务、备份定时器、Nginx 模板和发布脚本。模板默认使用 `/opt/mail-opus-viewer-v2` 作为应用目录，部署前应按实际环境调整域名、证书路径和外部服务配置。

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

完成首次部署后，使用发布脚本执行后续构建、重启和健康检查：

```bash
git pull --ff-only
./deploy/release.sh
```

## 备份

备份任务会依次执行源数据库完整性检查、SQLite 在线备份、备份文件完整性检查和外键检查。默认每 6 小时运行一次，并保留最近 45 份备份。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `V2_BACKUP_DIRECTORY` | 备份目录 | `/var/backups/mail-opus-v2` |
| `V2_BACKUP_RETENTION` | 备份保留数量 | `45` |

## API 概览

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 服务状态、写保护状态和发布信息 |
| `GET /api/v2/version` | 当前发布清单 |
| `/api/v2/admin/*` | 管理员会话、账号、授权和批量操作 |
| `/api/login`、`/api/mails` | 客户登录与授权邮件访问 |
| `POST /api/v2/import/accounts` | 使用 `X-API-Key` 导入账号 |
| `POST /api/v2/internal/payment-exposure-check` | 写入结构化支付检查结果 |

管理写接口同时校验管理员会话与请求来源；集成接口使用独立 API 密钥。服务还启用了登录速率限制、禁止缓存、禁止页面嵌入、内容类型保护和 CSP 响应头。

## 目录结构

```text
src/server/   API、数据库、同步任务和领域逻辑
src/shared/   前后端共享类型
web/src/      React 管理后台与客户界面
tests/        领域规则、数据同步、写入流程和安全测试
scripts/      构建清单生成与校验脚本
deploy/       systemd、Nginx 和发布配置
```

## 安全

请勿在公开 Issue 中提交真实凭证、邮箱数据或内部服务地址。安全问题请通过 GitHub Security Advisories 私下报告，详见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
