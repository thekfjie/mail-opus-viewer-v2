<div align="center">
  <img src="docs/assets/opusmail.svg" width="80" height="80" alt="OpusMail" />
  <h1>OpusMail V2</h1>
  <p>账号有历史，凭证有版本，邮件有归属。</p>
  <p>
    <a href="https://github.com/thekfjie/mail-opus-viewer-v2/actions/workflows/ci.yml"><img src="https://github.com/thekfjie/mail-opus-viewer-v2/actions/workflows/ci.yml/badge.svg" alt="Verify" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A520.19-43853d" alt="Node.js ≥20.19" />
  </p>
  <p><a href="#快速开始">快速开始</a> · <a href="docs/architecture.md">架构</a> · <a href="docs/api.md">API</a> · <a href="docs/README.md">文档</a> · <a href="CONTRIBUTING.md">参与开发</a></p>
</div>

OpusMail 是一个可以自行部署的账号与邮箱管理后台。它把账号身份、邮箱绑定、凭证和客户授权分开记录，让换绑、凭证更新和邮件检索都有迹可查；日常查询和批量操作在同一个面板完成。

本仓库维护公开 V2 主线，包含 React 管理后台、Fastify API、单实例 Worker，以及 MySQL + Redis 部署配置。截图使用本地生成的演示数据。

![账号总览 · 深色主题](docs/assets/overview-dark.png)

## 可以做什么

| 模块 | 主要能力 |
| --- | --- |
| 账号管理 | 搜索与筛选、批量操作、渠道与标记、生命周期记录 |
| 身份与凭证 | 邮箱换绑历史、凭证版本链、身份冲突审查、管理员按需查看和复制 |
| 邮件索引 | 接收上游邮件事件、关联账号与绑定区间、按需读取正文和验证码 |
| 客户与分享 | 邮箱访问授权、撤销与过期、受访问次数约束的只读快照 |
| 后台任务 | 优惠资格检查、可选 Outlook 与外部账号服务同步、任务状态和审计 |
| 数据维护 | MySQL 迁移、旧 SQLite 校验导入、一致性备份与恢复验证 |

外部邮件、资格检查和代理服务需要自行接入，可选自动检查默认关闭。支付方式观察另依赖本机提炼服务，该服务不包含在仓库或 Compose 中；接入前需确认它的运行配置。

<table>
  <tr>
    <td width="72%"><img src="docs/assets/account-detail.png" alt="账号详情、绑定历史与凭证管理" /></td>
    <td width="28%"><img src="docs/assets/overview-mobile.png" alt="移动端浅色主题" /></td>
  </tr>
  <tr><td align="center">账号详情与历史</td><td align="center">移动端</td></tr>
</table>

## 快速开始

需要 Docker Engine 与 Compose。首次启动使用空库；已有 SQLite 数据请先读[迁移手册](docs/mysql-redis.md#已有-sqlite-数据迁移)。启动服务不会自动搬迁旧数据。

```bash
git clone https://github.com/thekfjie/mail-opus-viewer-v2.git
cd mail-opus-viewer-v2
cp .env.example .env
```

在 `.env` 中分别设置 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`REDIS_PASSWORD`、`V2_SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`、`VIEWER_ADMIN_PASSWORD` 和 `PUBLIC_ORIGIN`。新环境可多次运行 `openssl rand -hex 24` 生成独立密钥；迁移旧环境时保留原有加密密钥。

```bash
docker compose build
docker compose up -d mysql redis
docker compose run --rm migrate
docker compose up -d api worker
curl --fail http://127.0.0.1:8790/ready
```

通过 HTTPS 反向代理访问 `/admin`。API 默认只绑定宿主机回环地址，MySQL 和 Redis 不公开端口。Worker 只运行一个实例。

也可使用 Node.js 20.19+ 原生部署：准备 MySQL、Redis 和配置后，运行 `npm ci`、`npm run db:migrate`、`npm run build`、`npm start`，另启一个 `npm run worker`。详细步骤见[运行手册](docs/mysql-redis.md)。

## 后端怎么组织

账号身份是核心；邮箱绑定和凭证版本分别关联它，换邮箱不会凭空生成第二个身份。邮件只在本地保存索引与归属，正文从上游按需读取。

- **MySQL 8.4 LTS** 保存业务数据与持久任务状态，使用 InnoDB、外键和唯一约束。异步连接池、事务与嵌套保存点集中在存储层。
- **Redis 7.x** 通过 Lua 原子计数与 TTL 提供跨 API 实例限流，不缓存邮件正文或账号凭证。
- **API 与 Worker 分开运行**：API 处理交互与集成请求，Worker 执行同步、补漏与检测。API 可以多实例，Worker 尚未实现分布式任务租约。
- **敏感字段加密保存**：管理员经过显式操作读取原文；客户和分享接口不返回管理凭证，敏感读取响应使用 `no-store`。

MySQL 是生产存储。SQLite 仅供旧快照导入和离线回归，真实数据库行为另有集成测试。表关系、事务边界与邮件事件流程见[架构说明](docs/architecture.md)。

## 一些处理过的问题

这些问题来自实际业务边界，也保留了对应回归测试：

- **换绑后账号顺序不对**：预创建的目标邮箱曾与完成换绑混在一起。现在区分占位与真实账号，并按完成时间处理换绑后的顺序。
- **优惠查询失败被当成没有优惠**：空目录、凭证失效和未完成的优惠码检查分开记录，不让一次不确定的响应覆盖历史结论。
- **邮件重复推送破坏已有记录**：补充的元数据与已有归属合并，重试不重复生成索引，本地不保存邮件正文。
- **单连接迁移卡住**：迁移持有数据库锁时又向连接池申请连接；现已改为在同一连接执行迁移，并验证并发启动与重复执行。

[修复记录](docs/fixes.md)列出了问题背景、代码和测试入口。

## 开发与验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` 使用临时 SQLite 做离线业务回归。MySQL 方言、事务、外键、跨实例限流和备份恢复需要独立的 MySQL / Redis 测试环境：

```bash
# 使用专用测试服务及可创建临时库的账号；还需要 MySQL 8.x 客户端。
MYSQL_URL=mysql://root:password@127.0.0.1:3306/opusmail_test \
REDIS_URL=redis://127.0.0.1:6379 \
ENV_FILE=/dev/null npm run test:integration
```

CI 运行类型检查、业务回归、真实数据库集成测试和构建。已有[性能基线](docs/performance.md)附原始报告、数据规模和运行条件。

## 文档与代码

| 文档 | 内容 |
| --- | --- |
| [架构说明](docs/architecture.md) | 模块职责、核心关系、事务与任务边界 |
| [部署与数据迁移](docs/mysql-redis.md) | Compose、SQLite 导入、备份、恢复与回滚 |
| [配置说明](docs/configuration.md) | 必填配置、可选集成和历史兼容项 |
| [API 接入](docs/api.md) | 认证方式、账号导入、换绑、邮件事件和任务接口 |
| [修复记录](docs/fixes.md) | 问题、处理方式及回归测试 |
| [性能验证](docs/performance.md) | 可复现的本地负载基线 |
| [界面截图](docs/showcase.md) | 演示数据与截图复现方法 |

```text
src/server/       HTTP 接口、领域服务、外部服务适配与 Worker
  storage/        MySQL 适配、表结构、迁移与旧数据导入
  infrastructure/ Redis 限流等基础设施
src/shared/       前后端共享契约
web/src/          React 界面与样式
tests/            业务回归；integration/ 使用真实 MySQL 与 Redis
scripts/          构建、验证、性能测量与演示截图
deploy/           发布、备份、systemd 与 Nginx 配置
docs/             当前文档；archive/ 保存历史方案
```

`main` 的说明只描述已实现的功能。历史设计放在[归档](docs/archive/README.md)，实验改动使用独立分支和 PR，验证并合并后再进入主线文档。

## 参与和安全

欢迎提交可复现的问题和改进，开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿在 Issue 或截图中附带真实凭证、邮件和内部地址；安全问题通过 GitHub Security Advisories 私下报告，详见 [SECURITY.md](SECURITY.md)。

[MIT License](LICENSE)
