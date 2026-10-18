# 修复记录

这里记录少量会影响使用和数据判断的问题，以及对应的回归入口。不是逐提交流水账；普通样式调整和代码整理不逐条列出。

## MySQL 单连接迁移等待

迁移先从连接池取得连接并持有 MySQL 命名锁，随后通过池执行结构语句。连接池只有一个连接时，结构语句拿不到连接，迁移便一直等待。

锁、建表、外键检查和版本写入现统一在同一会话执行，释放锁后归还连接。测试同时启动两个迁移调用，其中一个使用容量为 1 的池，再重复运行并检查只有一条版本记录。

- 实现：[`storage/migrate.ts`](../src/server/storage/migrate.ts)
- 回归：[`integration/mysql-redis.test.ts`](../tests/integration/mysql-redis.test.ts)，`one-slot migration and concurrent deployers…`
- 提交：[`a469a04`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/a469a04)；业务表结构不变，无需重新导入数据。

## 换绑占位与真实账号混淆

预创建目标邮箱只是任务占位，不能直接显示成一个新账号。取得新凭证并完成绑定后，才按完成时间处理顺序；已完成但缺 AT 的账号仍应显示，方便补充。

- 回归：[`rebind-order.test.ts`](../tests/rebind-order.test.ts)、[`pending-credential-visibility.test.ts`](../tests/pending-credential-visibility.test.ts)
- 公开源代码已包含于 [`3d44d81`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/3d44d81)。该提交是源代码汇总，不代表问题最初就在这一天修复。

## 未确定的优惠结果被当成否定

目录没有返回活动，不一定代表已查询的优惠码不可用；网络失败和凭证失效也不能作为没有优惠的证据。解析器区分这些情况，多账号响应需要匹配目标身份，不从第一行随意取值。

已有明确结果与失败观察分别保留。后一次结果与历史优惠冲突时，可以标记存疑，让管理员看到判断依据。

- 回归：[`promotion-parser.test.ts`](../tests/promotion-parser.test.ts)，包括空目录、优惠码补充、不确定结果及多账号匹配
- 这些行为已存在于公开基线 [`3d44d81`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/3d44d81)，本轮整理其说明。

## 重复邮件事件与索引补充

上游可能先推通知、后补元数据，也可能重投同一消息。重试需要沿用上游消息 ID 合并索引，保留已有归属和绑定信息，避免将不完整事件当成完整邮件覆盖。本地库保存检索与归属元数据，正文按需读取。

- 回归：[`mail-metadata-event.test.ts`](../tests/mail-metadata-event.test.ts)、[`mail-ingestion-reliability.test.ts`](../tests/mail-ingestion-reliability.test.ts)
- 公开基线：[`3d44d81`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/3d44d81)

## 数据库迁移中的兼容边界

MySQL 不能直接照搬 SQLite 的 upsert 和忽略冲突语义。针对错误唯一键的 upsert 不能修改另一条绑定；外键错误不能被忽略；导入失败也不能留下半批数据。

存储适配层限制冲突目标，导入在单个事务内校验并提交，集成测试使用真实 MySQL 验证这些边界，同时执行一次逻辑备份恢复并比较数据摘要。

- 实现与公开提交：[`12f9fc9`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/12f9fc9)
- 回归：[`integration/mysql-redis.test.ts`](../tests/integration/mysql-redis.test.ts)
- 部署与恢复步骤：[MySQL + Redis 手册](mysql-redis.md)

## 收信诊断仍显示旧存储

数据库已迁移，但收信状态仍固定显示 SQLite、Redis 未接入，以及一个不存在的学习文档入口。诊断现在按实际存储适配返回租约来源和限流后端，移除学习内容；“使用 Redis”与“Redis 当前可用”分别由配置说明与 `/ready` 表达，不在本地统计接口里额外探测上游。

- 实现：[`mail-health.ts`](../src/server/mail-health.ts)、[`收信面板`](../web/src/mail-health.tsx)
- 回归：[`mail-health.test.ts`](../tests/mail-health.test.ts)，同时在离线 SQLite 与真实 MySQL 业务契约中执行
- 提交：[`a469a04`](https://github.com/thekfjie/mail-opus-viewer-v2/commit/a469a04)
