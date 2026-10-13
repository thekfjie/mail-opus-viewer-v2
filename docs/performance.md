# 可复现性能验证

压测对象是已登录管理员访问的 `/api/v2/admin/accounts?limit=50`，每个请求真实读取 MySQL，并进行业务数据转换和加密邮箱解密。预热 5 次后统计成功 QPS、P50/P95/P99、失败比例。它不是 `/health` 的空响应测试。

## 运行

对你控制的预发布环境：

```bash
# 使用受保护环境提供口令，不把口令贴进日志、命令历史或报告。
export BENCH_URL=http://127.0.0.1:8790
export BENCH_CONCURRENCY=10
export BENCH_SECONDS=60
export BENCH_OUTPUT=artifacts/benchmark.json
mkdir -p artifacts
npm run benchmark
```

`BENCH_ADMIN_PASSWORD` 必填；只用于一次登录，不写入报告。脚本不打印响应内容、Cookie 或口令，HTTP/业务响应失败会计入错误率并让命令返回失败。默认上限 200 个客户端、300 秒。使用闭环负载模型：每个客户端收到响应后才发下一次，不能据此推断固定到达速率下的排队上限。

本仓库还提供合成数据演练，要求单独的测试 MySQL、Redis 和建库权限：

```bash
MYSQL_URL=mysql://root:password@127.0.0.1:3306/opusmail_test \
REDIS_URL=redis://127.0.0.1:6379 \
FIXTURE_ROWS=500 BENCH_SECONDS=10 BENCH_CONCURRENCY=1,10 \
npm run benchmark:fixture
```

脚本创建随机临时数据库，填充 500 个账号、500 份凭证、500 条邮件元数据和归属记录，检查真实行数，刷新导入后的查询优化器统计信息（`ANALYZE TABLE`），启动单个 API。完成后关闭服务并删除临时库。报告写入 `docs/benchmarks/local-c1.json` 和 `local-c10.json`。源码摘要会标识实际执行代码；`revision` 是当时 Git HEAD，`dirtyWorktree` 明确说明是否含未提交改动。

## 开发环境实测（北京时间 2026-10-14）

MySQL 8.0.46、Node.js 24.19.0、连接池 10、单 API；500 个合成账号及对应凭证、邮件和归属记录。负载生成器与服务共机，宿主机可见 9 个 CPU、约 9.7 GiB 内存，这不是专属资源配额。每组预热 5 次，持续约 10 秒。

| 并发客户端 | 成功请求数 | 成功 QPS | P50 | P95 | P99 | 失败率 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 526 | 52.55 | 18.64 ms | 21.63 ms | 26.21 ms | 0% |
| 10 | 2230 | 222.07 | 43.77 ms | 61.98 ms | 73.92 ms | 0% |

原始报告：[1 客户端](benchmarks/local-c1.json)、[10 客户端](benchmarks/local-c10.json)。报告包含实际服务源码 SHA-256；这次测量发生在提交前，因此 Git 修订号指向基线，`dirtyWorktree=true`。未做等条件的旧版 SQLite 对照测试，不能据此声称相对旧版提升多少倍。

## 解读

这些结果只是开发环境的功能性负载基线。负载生成器、API、MySQL、Redis 共用宿主机，没有公网 TLS、没有真实外部邮件/资格 API、没有 Worker 并行工作，也没有长期写入与数据库增长。不能据此写“线上支持 X 万用户”或声称已经超过旧版 SQLite。

上线容量测试应在实际 VPS 上，使用代表性数据量与读写比例，至少运行数分钟，记录 CPU/内存限制、服务版本、磁盘、网络、连接池、数据规模、外部 API 延迟及错误率。并发客户端、每秒请求数和注册用户数是三个不同指标。建议给出明确目标，例如“P95 < 500ms，错误率 < 1%”，逐级加负载直至触及目标，不只挑选最高 QPS。

当前改进包括异步数据库访问、有限连接池、事务约束、Redis 跨 API 限流，以及列表账单邮件从逐账号查询改为每页一次批量查询，并先分页账号 ID，再读取该页的复杂证据字段。复杂账号列表仍包含相关子查询；兼容 `/api/admin/mappings` 仍会汇总完整列表，应作为单独的重负载场景测试。Worker 当前只支持单实例。缓存敏感业务结果和横向扩容 Worker 均不在此次实现范围。

## 可核验的简历描述

“将账号与邮件管理平台迁移到 MySQL + Redis：改造异步数据访问与事务，保留 51 张业务表及加密字段；实现跨实例原子限流、带 SHA-256 校验和失败回滚的数据导入、备份恢复演练、Docker Compose 部署与真实数据库集成测试。”

真实用户数量和长期运行时间需上线后持续记录。压测数字应引用具体报告和机器配置，不能用合成数据填充运营人数。
