# MySQL + Redis 运行与迁移手册

生产数据存储已切换到 MySQL。Redis 用于 API 多实例共享限流；邮件正文、验证码和访问令牌不写入 Redis。SQLite 仅保留旧数据导入及离线回归用途，`NODE_ENV=production` 会拒绝 `OPUS_SQLITE_TEST=1`。

## 组件职责与边界

| 组件 | 职责 | 运行约束 |
| --- | --- | --- |
| Fastify API + React | 管理、鉴权、账号/邮件查询 | 可启动多个 API 实例；配置相同的会话密钥、加密密钥、MySQL 和 Redis |
| MySQL 8.0.16+ / 8.4 LTS | 51 张业务表、事务、外键、唯一约束、持久任务状态 | InnoDB；大小写及尾随空格敏感的 `utf8mb4_0900_bin`；UTC/ISO 时间语义不变 |
| Redis 7.x | Lua 原子计数和 TTL，跨 API 实例限流 | 故障返回 503；不降级为每进程独立计数；使用 noeviction，容量不足时拒绝受限请求 |
| Worker | 同步邮件、资格检查等后台工作 | **只运行一个 Worker**；现有调度不是分布式任务租约，不能直接横向扩容 |
| SQLite 工具 | 读取旧 v29 快照、离线测试 | 不用于生产 API 数据库；旧版修复/审计脚本仍只适用于旧快照 |

MySQL 连接池每进程默认 10 条，队列最多 100 个等待请求。显式业务事务使用 SERIALIZABLE 隔离，嵌套事务用 SAVEPOINT；发生死锁时回滚并返回错误，不自动重放可能带外部副作用的业务回调。普通单条查询不自动升级成跨业务事务。

SQL 方言转换集中在 `src/server/storage/mysql-sql.ts`，覆盖现有查询中的 upsert、日期、JSON 聚合、字符串拼接及标量 min/max。它不是通用 SQL 解析器，新增特殊 SQL 必须补真实 MySQL 测试。保留离线 SQLite 测试不能代替生产数据库验证。

## 新环境启动（Docker Compose）

```bash
cp .env.example .env
openssl rand -hex 24
```

将独立生成的值分别填入 `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`REDIS_PASSWORD`、`V2_SESSION_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`，设置 `VIEWER_ADMIN_PASSWORD` 和正确的 `PUBLIC_ORIGIN`。Compose 密码使用十六进制，避免 URL 转义错误。旧环境迁移必须沿用原有加密密钥，不能重新生成。

```bash
docker compose build
docker compose up -d mysql redis
docker compose run --rm migrate
docker compose up -d api worker
curl --fail http://127.0.0.1:8790/ready
```

API 只发布到宿主机 `127.0.0.1:8790`；数据库和 Redis 不发布宿主机端口。由 Nginx 提供 HTTPS。`TRUST_PROXY` 只能列出实际反向代理地址或专用网段；Docker 场景需配置实际代理源地址，不要信任所有 IP，否则客户端可以伪造限流身份。多台 API 必须共用 `REDIS_PREFIX`。

容器内 `127.0.0.1` 指向该容器自身。外部邮件服务、资格 API 等地址需要改成容器可访问的地址。镜像包含项目现有 Python 探测依赖；外部服务是否可用仍取决于你的接入配置。默认关闭可选自动检查。

`/health` 是进程存活检查；`/ready` 检查 MySQL 和 Redis 可用性，不代表完成全表完整性检查。容器变为 unhealthy 不会自动触发 Docker 重启，应由监控告警或编排系统处理。

## 已有 SQLite 数据迁移

此次发布是破坏性运行配置升级：仅更新代码后直接重启不会自动导入 SQLite，也不会自动创建生产表。

1. 安排维护窗口，停止旧 API、Worker 和所有写入脚本，保留旧版提交、环境配置和服务文件。不要改动 V1 服务及它的回退配置。
2. 使用旧版在线备份命令或当前 `npm run backup:sqlite-legacy` 创建一致性 SQLite 快照。必须保留 `CREDENTIAL_ENCRYPTION_KEY` 与会话密钥。若旧版未显式设置加密密钥，旧加密源是原会话密钥加上 `:mail-opus-v2-credentials`；将这个完整字符串作为新 `CREDENTIAL_ENCRYPTION_KEY`，不要换成随机值。
3. 确认快照为 SQLite schema v29。更旧快照先在**副本**上用旧版迁移升级；不要尝试修改生产原文件。保留原始备份。
4. 配置空的 MySQL 数据库，运行建表迁移。使用宿主机 Node 工具时，`.env` 的 `MYSQL_URL` 必须指向宿主机可连接的 MySQL；Compose 网络内迁移使用下面的容器命令。

```bash
# 原生 Node 部署（需要可访问的 MYSQL_URL）
npm ci
npm run db:migrate
npm run db:import-sqlite -- /absolute/path/backup.sqlite /absolute/path/import-report.json
```

```bash
# Compose 部署：将停写后的备份放进 .state/migration/，不挂载整个生产目录
mkdir -p .state/migration .state/backups
# 复制 backup.sqlite；确保容器 node 用户可以只读访问，目录不要对外开放
# .state/migration/ 中只放用于迁移的快照
docker compose run --rm migrate
docker compose run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/.state/migration:/migration:ro" \
  -v "$PWD/.state/backups:/reports" migrate \
  node dist/server/server/storage/import-sqlite.js /migration/backup.sqlite /reports/import-report.json
```

导入器要求目标业务表为空（允许建表时的 `mail_read_control` 初始行），检查源表/列、外键、完整性和字段长度；按依赖顺序写入。整批使用一个 InnoDB 事务，任何失败都会回滚。按稳定列顺序计算逐表行数及 SHA-256，验证通过才提交；加密字段原样复制。源文件以只读方式打开。

目标库不要同时运行应用、Worker 或 DDL。导入会占用事务日志和空间，大库应先在同等资源的预发布环境演练，测量停机窗口。导入后再次运行会明确拒绝非空目标，不会合并或覆盖。

5. 检查报告的 51 张表、行数、校验值；启动新 API，保持 Worker 停止。验证管理员登录、账号列表、完整凭证查看/复制、客户权限隔离以及 `/ready`。随后启动一个 Worker，检查心跳与外部集成。
6. 确认恢复演练成功后，再结束维护窗口。此仓库的测试不等于你的线上数据已经完成迁移。

## 备份与恢复

Docker 部署：

```bash
bash deploy/backup-compose.sh
```

原生 Node 部署需要安装 **MySQL 官方 8.x 客户端**：

```bash
npm run build
npm run backup
```

使用 `mysqldump --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF` 导出 InnoDB 一致性快照并压缩，只有成功才发布最终文件。备份期间不能运行 DDL。原生命令通过权限 0600 的临时客户端配置传递密码，不放在命令行参数。备份包含加密业务数据、口令哈希等敏感信息，必须异地保管，且加密密钥独立备份。

默认路径 `.state/backups`；此版本不自动清理历史备份，按磁盘容量和恢复需求制定保留策略。定时器可继续使用，但需同步环境和 MySQL 客户端。每天自动备份不等于每天有可恢复的备份，应定期恢复到独立空库，并检查表行数、关键业务查询、密钥解密与应用登录。

```bash
# 将 dump 恢复到已经创建的隔离库 opusmail_restore；命令不会主动清空现有库。
# MYSQL_PWD 由受保护环境提供，避免在历史命令中写明文密码。
gzip -dc .state/backups/your-backup.sql.gz | mysql -h HOST -u USER opusmail_restore
```

## 回滚

新系统开放写入**之前**，可以停止新服务，恢复旧版代码、环境及 SQLite 快照，再启动旧服务。新系统开放写入**之后**，旧快照不包含新增数据，不能直接切回：先停写、备份 MySQL 并评估增量迁回或修复后继续运行。当前没有自动 MySQL 转 SQLite 的逆迁移工具。

`deploy/release.sh` 适用于后续已有 MySQL 环境：测试、构建、备份、迁移、重启、就绪检查。旧 `cutover-v2.sh`、`production-backup.mjs`、SQLite 审计/修复工具属于 V1/SQLite 历史流程，不适用于此次 MySQL 首次切换；不要混用。

## 验证

```bash
npm run typecheck
npm test
# 需要真实 MySQL、Redis；测试账号需要创建/删除临时测试库权限，不能用生产账号。
# 还需 mysql / mysqldump 8.x 客户端用于恢复演练。
MYSQL_URL=mysql://root:password@127.0.0.1:3306/opusmail_test \
REDIS_URL=redis://127.0.0.1:6379 npm run test:integration
npm run build
```

集成测试使用随机命名的独立库，不清空指定的默认库。覆盖单连接与并发迁移、重复迁移、503 行跨页导入、导入失败整批回滚、密文保留、嵌套事务、唯一键冲突、外键、管理员 API、限流共享/过期/故障、逻辑备份恢复，再运行现有 21 组业务契约。CI 另外构建 Docker 镜像。

## 性能验证

见 [performance.md](performance.md)，包含列表接口的测试方法、环境条件和原始报告。现有结果是本地合成数据基线；线上容量需在实际部署环境测量。

参考：[MySQL mysqldump](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html)、[Redis INCR 原子限流](https://redis.io/docs/latest/commands/incr/)。
