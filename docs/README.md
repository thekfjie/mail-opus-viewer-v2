# 文档

首次部署从[运行手册](mysql-redis.md)开始；想了解实现可先读[架构说明](architecture.md)。

| 文档 | 适用场景 |
| --- | --- |
| [架构](architecture.md) | 理解账号、绑定、凭证、邮件与任务之间的关系 |
| [运行与迁移](mysql-redis.md) | 部署 MySQL / Redis、迁移旧库、备份与恢复 |
| [配置](configuration.md) | 设置必要密钥和可选服务 |
| [API](api.md) | 接入账号导入、管理操作和邮件事件 |
| [修复记录](fixes.md) | 查找业务边界与对应回归测试 |
| [性能验证](performance.md) | 复现列表接口负载测试，阅读原始报告 |
| [订阅状态契约](openai-subscription-contract.md) | 理解账单证据如何影响套餐判定 |
| [展示图](showcase.md) | 用临时演示库重新生成截图 |

当前生产架构为 MySQL + Redis；SQLite 仅用于迁移和离线回归。[历史方案](archive/README.md)保留背景，不作为当前部署步骤。实验功能使用独立分支与 PR，不在此处列为已交付能力。
