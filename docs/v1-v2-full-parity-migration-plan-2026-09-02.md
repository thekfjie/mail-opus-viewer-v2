# Mail Opus V1 -> V2 全量功能对齐与切换计划

日期：2026-09-02
范围：`/opt/mail-opus-viewer`（V1）、`/opt/mail-opus-viewer-v2`（V2）、V1 邮件索引、V2 SQLite、Sub2API、Outlook 管理服务、Automyai 优惠检测链路
本轮动作：只读审计与实施计划，不修改生产业务状态

## 1. 结论

V2 现在可以作为只读影子站点继续运行，距离替代 V1 还差四个基础能力闭环：

1. V1 的账号来源、邮箱类型、收件方式和操作规则没有完整进入 V2 的领域模型。V2 能筛选 `provider`，但没有保存 `autoFlag`、独立收件连接、路由规则、停收边界、显示策略等关键语义。
2. V1 -> V2 同步仍通过整库删除再重建投影完成。V1 每次配置或邮件索引变化都会重建主要表，再恢复 V2 检测结果，这一机制只适合短期影子迁移。
3. V2 把一组 GPT 身份压成一行当前凭证，缺少 AT/RT 版本历史、发现绑定、替换原因和当前凭证选择规则，因此“同一 GPT 换绑后继续使用凭证”和“回收后凭证严格隔离”难以同时可靠表达。
4. 优惠资格与支付方式暴露被绑在一个远程任务中。生产任务失败率很高，失败原因又基本没有落库；当前完成去重还会让一次错误的阴性结果永久阻止复查。

正确路线是：先固定身份、绑定、凭证、优惠和同步的不变量，再迁移 V1 工作台。共存期由一个统一命令入口写入事实，并通过持久化事件和幂等投影同步；对账通过后再切换唯一写入端。

## 2. 审计快照

以下为 2026-09-02T10:58:16Z 的在线快照。V1 仍有自动导入，数字会继续增长；验收时按同一同步游标重新计算，本节数字只作为审计基线。

### 2.1 V1

| 项目 | 数量 |
| --- | ---: |
| 当前映射 | 681 |
| Auto/API | 356 |
| 普通/非 Auto | 325 |
| iCloud | 517 |
| 域名邮箱 | 140 |
| Outlook | 23 |
| 有 AT | 544 |
| 无 AT | 137 |

V1 当前文件约为：`access-config.json` 4.4 MB、`mail-index-cache.json` 5.3 MB。`app.js` 已有 13,434 行，页面、数据修复、邮件扫描、导入、账号状态和 API 写入集中在一个进程内。

### 2.2 V2

| 项目 | 数量/状态 |
| --- | ---: |
| GPT 身份 | 730 |
| 邮箱绑定 | 819 |
| AT 标记为 alive | 558 |
| 待审查 | 69 |
| 支付/优惠检测结果 | 130 |
| 自动检测完成 | 120 |
| 自动检测失败 | 596 |
| 自动检测停在 dispatching | 1 |
| SQLite 完整性 | `ok` |
| 外键错误 | 0 |

已经确认的数据语义问题：

- 47 个活跃身份没有当前绑定，全部来自恢复的 Outlook 历史记录；其中 43 个无 AT/身份未知，4 个有 AT/身份已确认。它们必须被重新判定为当前账号、历史记录或待审查，最终消除“活跃但无当前邮箱”状态。
- 91 条 `email_rebind` 被保存成 `from_account_id == to_account_id` 的账号自关联。换绑实际发生在两个邮箱绑定之间，应迁到绑定转换表；账号关系表只保留回收、替代等跨 GPT 身份关系。
- 5 组历史邮箱出现在多个 GPT 身份中。只允许它们由明确回收链解释，否则进入人工审查。
- 当前邮箱跨账号重复为 0，多当前绑定为 0，已售但无出售记录为 0。这些正确约束必须保留。
- 约 199 封邮件存在多 GPT 归属声明。客户查询目前通过 `NOT EXISTS` 在读取时屏蔽，但数据库里的 `visible_to_customer` 仍可能为 1。迁移后应把“有歧义”物化为明确状态，而不是只依赖查询时兜底。
- 596 个失败任务中有 594 个没有持久化错误信息。线上检测服务当前健康，说明历史任务失败、结果解析和本地状态保存需要分别治理。
- 8 条结果同时为 `trial_status=ineligible` 和 `promo_eligible=true`。这两个概念可以不同，但当前表和界面把它们混在同一个检测结果中，容易误判。

### 2.3 已验证的运行状态

- V1、V2 API、V2 Worker 均为 `active`。
- V2 为 `V2_READ_ONLY=true`，V1 是当前唯一业务写入端。
- V2 Worker 每分钟检查 V1 文件并同步 Sub2API；目前不是双向同步。
- V2 SQLite 每 6 小时生成一次经过完整性和外键验证的备份。
- V1 测试 84/84 通过；V2 测试 39/39 通过。现有测试证明局部规则没有回归，不代表功能对齐或生产数据不变量已经满足。
- V2 构建目录仍残留源码中已删除的 `automatic-promo-eligibility.js` 和 `promo-eligibility.js`。当前构建不会先清理 `dist/server`，发布脚本也只重启 API、不重启 Worker，这是发布一致性缺口。

## 3. V1/V2 功能对照矩阵

状态含义：`已有` 为当前实现可用，`部分` 为只有展示或只有底层能力，`缺失` 为没有等价工作流，`语义错误` 为存在实现但尚未满足业务切换条件。

| 领域 | V1 能力 | V2 当前 | 迁移要求 | 优先级 |
| --- | --- | --- | --- | --- |
| 总账号库 | 完整库存、新账号在上 | 已有，24 条分页 | 保持稳定 `arrived_at` 排序，任何状态变化不重排 | P0 |
| iCloud 分组 | 独立筛选、共享收件、回收规则 | 部分，仅 provider 筛选 | 独立工作台及数量；共享收件、别名代际、回收资格必须是服务端规则 | P1 |
| 域名邮箱分组 | 独立页面、精确 TO、永不回收 | 部分，有导航和筛选 | 补齐路由连接、精确收件、换绑来源、禁止回收规则 | P1 |
| Auto/API 分组 | `autoFlag` 独立页面 | 缺失，schema 无来源字段 | 保存来源与自动标记，提供独立工作台；可与 iCloud/域名分组重叠 | P1 |
| 暂无 AT | 待注册、重试、可操作队列 | 部分，仅统计/通用筛选 | 区分内部任务占位与真实账号缺 AT，提供独立处理队列 | P1 |
| Outlook 账号 | 管理服务引用、导入、转移 | 部分，仅 provider 和邮件正文读取 | 增加外部邮箱连接模型、导入预览和转移 | P1 |
| Outlook Free 号池 | 扫描、刷新、邮件列表、邮件详情、打开 | 缺失 | 完整搬迁为独立工作台 | P2 |
| 新增/导入 | Outlook 4/6 段、Session、iCloud、转移预览 | 部分，仅 JSON 数组 | 搬迁解析器、预览、逐行错误和密钥隐藏；统一写入领域服务 | P1 |
| 手动账号编辑 | 邮箱、收件路由、显示策略、来源、渠道等 | 部分，仅备注/支付链接/颜色/广告 | 内部字段进入详情编辑，不回到主列表 | P2 |
| Plus 识别 | 邮件证据、人工 Plus、历史修正 | 部分，严格邮件分类已存在 | 保存证据来源/版本/人工覆盖，禁止营销邮件误判 | P0 |
| 支付渠道 | 自动识别、人工覆盖、渠道筛选 | 部分，能展示/筛选，来源编辑尚未完整 | 区分 derived/override；已知渠道在套餐列直接显示渠道 | P1 |
| AT/RT 查看 | 单个查看、批量复制 | 已有 | 保留，改用当前凭证版本指针 | P0 |
| 批量 OAuth 覆盖 | 预览、哈希确认、应用 | 缺失 | 搬迁到凭证版本服务，不直接覆盖历史 | P1 |
| OAuth 验活 | 全量普通账号串行、状态进度 | 缺失 | 独立任务表、限流、AT/RT 分开结果和复查策略 | P1 |
| 12 小时优惠检测 | 后加能力 | 有但不可靠 | 独立 JP 优惠状态机，权威读取 `eligible_promo_campaigns.plus` | P0 |
| 支付方式探测 | 多区域渠道探测 | 已有但和优惠耦合 | 与优惠拆开，互不决定成功/失败 | P1 |
| 管理员最近邮件 | 账号内预览 | 缺失 | 放在详情抽屉，不恢复主列表多余按钮 | P2 |
| 验证码提取 | 按 mapping/email 获取 | 缺失 | 管理员详情提供复制验证码；保留收件窗口和归属限制 | P1 |
| 客户邮件页 | 历史邮件、详情、旧链接 | 已有且界面可保留 | 锁定行为，只做兼容和回归测试 | P0 |
| 客户修改密码 | 已有 | 缺失 | 搬迁且绑定到授权，不修改 GPT/邮箱内部密码 | P2 |
| 停止新邮件 | 地址级截止、历史保留 | 缺失 | 增加 binding 级 cutoff，并将影响范围限定在目标 binding | P1 |
| 停用/归档 | 邮件触发、永久锁、历史保留 | 部分，永久停用已有 | 补齐邮件证据、地址截止和展示规则 | P0 |
| 回收 | 停用 7 天、Free 无标记、无效 AT、别名轮换 | 部分，仅手工输入新邮箱 | 搬迁四种模式、资格原因、代数上限和批量预览 | P1 |
| 出售/授权 | 已售标记与接码链接 | V2 领域模型更严格 | 保留 V2 原子出售/授权；共存期兼容 V1 既有链接 | P0 |
| 分享快照 | 限时/限次后台分享 | 缺失 | 独立于客户授权搬迁，支持撤销和访问计数 | P2 |
| 使用痕迹审计 | 查找疑似未使用 | 部分，只投影结果 | 搬迁执行器、进度和证据 | P2 |
| 标色/红色分组 | 人工标色 | V2 已有标色和边界分组 | 保留并纳入同步事件 | P1 |
| 批量导出 | 说明、AT、TXT/CSV/JSON | 已有 | 保持完整复制、已售警告和新旧顺序 | P1 |
| 邮件扫描状态 | 后台扫描进度/耗时 | 缺失 | 增加 V2 邮件同步健康、游标、延迟和错误 | P1 |
| 数据同步 | V1 本地 JSON 写入 | 语义错误，整库重建 | 改为增量事件和幂等投影 | P0 |
| 备份 | V1 文件备份 | V2 已有校验备份 | 加入恢复演练、同步游标和事件日志 | P0 |
| 发布 | V1 有 release 校验 | 部分，dist 可残留且 Worker 不随发布重启 | 干净构建、API/Worker 同版本、启动前验证 | P0 |

## 4. 必须先固定的业务不变量

### 4.1 GPT 身份、邮箱绑定和回收

1. `gpt_accounts` 表示一个 GPT 身份，不表示一个邮箱地址。
2. 管理员明确换绑：GPT 身份不变，旧 binding 截止，新 binding 成为当前；出售、停用锁和账号时间线留在同一身份上。
3. 停用后回收：创建新的 GPT 身份；旧身份、旧凭证、Plus、出售和客户权限都不进入新身份。
4. 活跃且可操作的账号必须恰有一个当前 binding。只有明确的历史/待审查状态可以没有当前 binding。
5. 同一邮箱可以在不同代 GPT 身份的历史中出现，但必须由回收链或人工决议解释；每个当前邮箱只对应一个账号的当前 binding。
6. 本地部分相同只代表候选关系，不足以合并身份。OpenAI subject、明确任务 ID、完整邮箱和回收边界的优先级必须固定。
7. `email_rebind` 是 binding -> binding 的转换；`mailbox_recycle` 才是 account -> account 的关系。

### 4.2 AT/RT 归属和“继承”

“继承”定义为：同一 GPT 身份在换绑邮箱后仍引用该身份当前有效的凭证版本，而不是把旧邮箱记录里的密钥复制覆盖到新邮箱记录。

规则：

1. 每次发现 AT/RT 都追加 `credential_version`，保存指纹、加密密钥、OpenAI subject、来源、首次/最后观察时间、观察时所在 binding、验活状态和替换关系。
2. 每个 GPT 身份只有一个 `current_credential_version_id`。选择优先级依次为：subject 与身份一致、验活成功、来源可信、观察时间较新。
3. 明确换绑不会清空当前凭证指针；若新 binding 后观察到同 subject 的新 AT，则创建新版本并替换指针，旧版本进入历史。
4. 新 AT 的 subject 与身份冲突时，不替换当前指针，账号进入审查；客户授权是否冻结按冲突级别处理。
5. 历史 binding 上再次看到同 subject，只新增观察事件，不把历史 binding 改回当前。
6. 回收出的新 GPT 身份没有当前凭证；即使邮箱家族相同，也不继承旧身份 AT/RT。
7. 手工批量覆盖必须先预览目标身份、当前版本、输入 subject 和替换结果；确认哈希不一致时终止应用。
8. AT 更新后重新记录 `first_seen_at`，并重新启动 12 小时优惠检测时钟；相同指纹不会重置时钟。

### 4.3 邮件和客户权限

1. 邮件属于 binding 时间窗口，再由明确换绑任务、完整收件地址和 GPT 身份证据决定 account 归属。
2. 多账号归属的邮件必须进入 `ambiguous`，所有客户入口都不可见；管理员可以查看证据和裁决。
3. 当前客户授权只看当前 binding 及允许跨阶段的安全邮件；历史授权只能看到自己的截止时间以前的邮件。
4. 地址级停止收件只设置该 binding 的 `receive_disabled_at`，保留历史，不影响同身份其他 binding。
5. 域名邮箱必须按精确收件地址路由；iCloud 共享池必须先按 SMTP/别名证据分发，并排除“最新一代”兜底抢占。
6. 客户页面继续隐藏内部转发地址、原始收件目标、邮箱管理凭证和支付链接。

### 4.4 出售、停用和排序

1. “已售”为确定性正向事实；没有标记表示销售状态未知。
2. V2 继续要求出售与客户授权原子创建，不恢复 V1 的松散双写。
3. 永久停用锁不可逆；换绑、发现 Plus 或发现新 AT 后仍保持锁定。
4. 新账号在上、旧账号在下只由不可变 `arrived_at` 和稳定 ID 决定。停用、归档、回收、检测和编辑后维持原顺序。

## 5. 目标数据结构

现有 `gpt_accounts`、`mailbox_families`、`email_bindings`、`sales`、`access_grants`、`mail_messages` 可以保留。以下结构通过版本化迁移增量加入，不再依赖启动时 `ensureColumn` 和整库重建：

### 5.1 账号来源和工作台字段

- `account_origins(account_id, source_type, source_id, is_auto, first_seen_at, metadata_json)`
- `account_preferences(account_id, label, hide_billing, show_deactivation, hide_promotion, status_message, updated_at)`
- `billing_channel_observations(account_id, channel, source, evidence_id, observed_at, active)`
- `gpt_accounts.billing_channel_override` 与 derived channel 分开保存

分组由服务端查询构建，不存互斥“分组名”：同一账号可以同时属于 `icloud`、`auto`、`missing_at` 等多个工作台。

### 5.2 邮箱连接和路由

- `mailbox_connections(id, binding_id/mailbox_family_id, provider, external_account_id, external_group_id, secret_ref, status, last_checked_at)`
- `mail_routing_rules(id, binding_id, sender_pattern, recipient_pattern, valid_from, valid_to, source, priority)`
- `email_bindings.receive_disabled_at`

这部分承接 V1 的 `address`、`sourceEmail`、`toEmail`、`fromPatterns`、`toPatterns`、`outlookManagerEmail`、`outlookManagerGroupId`，字段只在管理员详情展示。

### 5.3 换绑与凭证

- `binding_transitions(id, account_id, from_binding_id, to_binding_id, changed_at, method, task_id, evidence_json)`
- `credential_versions(id, account_id, observed_binding_id, subject_hash, access_token_enc, refresh_token_enc, id_token_enc, session_token_enc, token_fingerprint, first_seen_at, last_seen_at, validity_status, validity_checked_at, source, supersedes_id, retired_reason)`
- `account_current_credentials(account_id, credential_version_id, selected_at, selection_reason)`
- `credential_observations(id, credential_version_id, binding_id, source, observed_at, evidence_json)`
- `oauth_health_jobs` / `oauth_health_results`

迁移完成后删除 `credentials` 的单行覆盖职责；过渡期保留只读兼容视图。

### 5.4 优惠检测

- `promotion_jobs(id, account_id, credential_version_id, campaign, region, due_at, attempt, status, error_class, error_detail, next_retry_at, created_at, updated_at)`
- `promotion_observations(id, job_id, account_id, credential_version_id, campaign, eligible, result_status, upstream_status, evidence_path, response_hash, checked_at, expires_at)`

支付方式继续使用自己的 `payment_exposure_jobs/checks`，不再承载优惠最终结论。

### 5.5 同步和审计

- `change_outbox(sequence, event_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_json, occurred_at, committed_at)`
- `sync_consumers(consumer, last_sequence, last_event_id, updated_at)`
- `sync_conflicts(id, source, aggregate_id, expected_version, received_version, payload_json, status, created_at)`
- `source_links(source_system, source_id, aggregate_type, aggregate_id, source_version)`

每个业务写入必须产生可重放事件。同步使用 sequence、event_id 和 aggregate_version 幂等，文件大小/mtime 只作为唤醒信号。

## 6. 优惠检测重做方案

### 6.1 权威判定

优惠检测固定使用 JP 出口，请求 `/backend-api/accounts/check/v4-2023-04-27`。最终结论只来自目标账号记录的 `eligible_promo_campaigns.plus`（以及兼容形态），不由支付方式是否成功决定。

解析器必须覆盖以下响应形态：

- `eligible_promo_campaigns.plus` 为带 `id` 的对象。
- `plus` 为字符串 campaign ID。
- campaign 容器为对象数组、字符串数组或对象 map。
- campaign ID 明确为 `plus-1-month-free`。
- metadata 表示 Plus、1 month、1 period，但 ID 使用新名称。
- 返回多个 accounts 时只接受 AT 中的 account ID/subject 对应项，排除第一项兜底逻辑。

判定：

- `eligible=true`：目标账号明确包含一个月 Plus campaign。
- `eligible=false`：请求成功、目标账号匹配成功、`eligible_promo_campaigns` 字段存在且明确不含目标 campaign。
- `unknown_retryable`：网络、代理、超时、429、5xx、响应解析失败、账号项缺失、字段缺失。
- `credential_invalid`：上游明确报告 AT 失效；同时触发 OAuth 验活，但不伪造成优惠不可用。

### 6.2 调度和复查

1. 新 AT 指纹首次发现后 12 小时创建一次自动任务。
2. AT 指纹变化后创建全新任务时钟。
3. 手动检测立即执行并绕过“已完成”去重，但同一账号只允许一个运行任务。
4. `unknown_retryable` 按 10 分钟、1 小时、6 小时、24 小时退避；记录最终错误类和远程 item 错误。
5. 阴性结果先在 24 小时后复查，之后每 7 天复查；campaign 规则版本变化时全量重判。
6. 阳性结果按 AT 指纹保留；AT 变化或 campaign 到期后重新检测。
7. Worker 每轮限制并发和 JP 节点速率，避免一分钟内重复把同一批失败任务打满。

### 6.3 黄金样本与验收

建立经过人工确认的匿名样本：至少 10 个有优惠、10 个无优惠、3 个 AT 失效、3 个代理/超时、以及多账号响应、字符串 campaign、对象 campaign 各 1 份。

验收：

- 黄金样本真阳性和真阴性均为 100%。
- 网络/解析错误统一记录为 unknown，false 仅来自完整权威响应。
- 每个新 AT 在首次发现后 `12h +/- 5min` 被调度。
- 每个任务有本地 attempt、错误、开始/完成时间和对应凭证版本。
- V2 UI 分开显示“1 个月优惠资格”和“支付方式探测”，不再用一个灯混合表达。

## 7. V1/V2 共存同步方案

### 7.1 原则

共存采用单主写入。任一时刻只有一个业务事实写入端；双主写入会使出售、停用、换绑、邮件截止和凭证替换失去确定合并规则。

### 7.2 共存阶段的数据流

第一阶段（V1 唯一写入）：

1. V1 所有写操作先进入统一 command service。
2. V1 保存映射时改为临时文件写入、`fsync`、原子 rename，并递增 source revision。
3. 同一次命令追加持久化 outbox 事件。进程崩溃后通过 revision 对账补发，不允许静默漏事件。
4. V2 按 sequence 增量消费事件并更新领域表，不删除整库。
5. V2 UI 中的写操作通过兼容 command API 提交给 V1，等待对应 event_id 回流 V2 后才显示成功。
6. V2 自己产生的优惠、OAuth 验活等派生结果写入 V2，并向 V1 提供只读摘要接口，使两个后台看到同一结果。

第二阶段（V2 唯一写入、V1 兼容运行）：

1. 切换 command router，使 V2 成为唯一写入端。
2. V2 每个命令写本地事务和 outbox。
3. V1 只读兼容投影器按 V2 事件生成 V1 所需的 JSON/缓存字段；V1 页面不再直接修改本地文件。
4. 所有旧客户链接继续由 V2 `legacy_public_token` 兼容解析。
5. 观察期结束后停止 V1 服务和兼容投影器。

### 7.3 邮件同步

邮件上游是独立事实源，不应长期把 V1 `mail-index-cache.json` 当主库：

1. 初次迁移继续导入 V1 历史索引，记录 source cursor 和 response hash。
2. V2 增量读取共享邮件 API 和 Outlook 管理服务，分别维护 mailbox cursor。
3. 每封邮件先只写一次 `mail_messages`，归属作为可重算 claim 保存。
4. V1/V2 共存时执行归属差异报告：唯一归属一致、时间窗口一致、客户可见性一致。
5. 明确换绑窗口、共享 iCloud 别名、域名精确 TO、回收代际分别建立固定回归样本。

## 8. 分阶段实施

### Phase 0：发布和审计护栏（P0）

工作：

- 构建前清理目标 `dist/server` 和 `dist/web`，彻底移除无源码所有权的旧模块。
- 发布脚本同时重启并验证 V2 API、Worker；Worker 写入版本/心跳，API 展示两者是否同一 artifact。
- 对 V1 config、V1 mail index、V2 SQLite、V2 WAL/SHM 执行一致性快照和恢复演练。
- 把本计划中的不变量做成只读审计命令和机器可读报告。
- 建立匿名生产形状 fixture，避免只用过度简化的单元数据。

验收：干净 checkout 构建中没有孤儿 JS；API/Worker artifact 一致；备份可恢复；审计命令退出码可作为发布门禁。

### Phase 1：版本化 schema 与无损回填（P0）

工作：

- 引入正式迁移目录和 schema 版本，不在 `db.ts` 启动时混合创建、补列和数据回填。
- 增加第 5 节表结构，在生产库副本上回填来源、路由、binding transition 和 credential version。
- 将 91 条账号自关联换绑迁为 binding transition。
- 分类 47 个活跃无当前 binding 的 Outlook 记录：可证实为当前的补当前 binding；纯恢复历史改为 `historical_only`；其余进待审查。
- 对 5 组跨身份历史邮箱验证回收链，其余项目进入审查。
- 为旧 `credentials` 和 `promo_eligibility_checks` 建兼容视图，确认新代码无读写后再删除历史表。

验收：0 FK、0 活跃可操作账号无当前 binding、0 多当前 binding、0 当前邮箱跨账号重复、0 `email_rebind` 账号自关联；迁移可重复执行且第二次为 no-op。

### Phase 2：优惠检测独立化（P0）

工作：实现第 6 节状态机、JP 单用途请求、完整解析器、错误分类、退避、复查和黄金样本；将现有 130 条结果作为历史证据导入，不直接信任冲突结论。

验收：黄金样本全过；手工与 12 小时自动检测都落入同一状态机；596 个历史失败被分类或重新排队，不再出现空错误。

### Phase 3：AT/RT 版本链与换绑继承（P0）

工作：

- V1 导入、Sub2API、V2 手工导入、批量 OAuth 全部调用同一个 credential observation service。
- 回填当前 91 组换绑的凭证版本，保留新旧指纹和观察 binding。
- 明确处理“来源有 AT、目标无 AT”“新旧 AT 相同”“新旧 AT 不同”“历史邮箱再次出现 subject”四类情况。
- 增加凭证指针选择、冲突隔离、人工重新归属和回滚操作。

验收：明确换绑不丢当前有效 AT；新同 subject AT 正确替换；冲突 AT 不覆盖；回收新身份无凭证；所有替换可追溯、可回滚。

### Phase 4：增量同步与共存 command router（P0）

工作：实现第 7 节 outbox、consumer cursor、source version、幂等事件、V2 -> V1 兼容投影；停止 `legacy-import.ts` 的 `resetProjection()` 生产路径。

验收：

- 连续 24 小时无漏事件、无重复副作用、同步延迟 p95 小于 10 秒。
- 在 V1 和 V2 分别发起新增、编辑、出售、停用、换绑、回收、标色、凭证更新，各端最终结果一致。
- 杀掉 Worker、重复投递、乱序投递后能从 cursor 恢复。
- 任意时刻只能有一个 command writer；切换开关有审计记录。

### Phase 5：核心工作台和管理操作（P1）

按使用频率先后搬迁：

1. `全部 GPT`、`iCloud`、`域名邮箱`、`Auto/API`、`暂无 AT` 五个服务端 preset 工作台。
2. 账号详情编辑：来源、路由、渠道覆盖、邮件显示策略、停收边界。
3. V1 多格式导入、Session 导入、Outlook 导入/转移预览。
4. 批量 OAuth 预览/应用、全量串行验活、验证码读取。
5. 四种回收模式及原因预览。
6. 使用痕迹审计和邮件同步状态。

验收：每个 V1 工作台有一份筛选契约测试；在同一 source revision 上，V1/V2 各工作台的 legacy ID 集合完全一致。重叠分组不互相排斥。

### Phase 6：次要但必须保留的工作流（P2）

工作：Outlook Free 号池、管理员邮件预览/详情、客户修改接码密码、限时限次分享快照、完整导出与审计历史。

验收：V1 每条管理 API 都在功能矩阵中标记为“V2 原生”“兼容代理”或“确认废弃”，不存在无结论路由。

### Phase 7：V2 管理界面收口（P1/P2）

界面约束：

- 主列表只保留邮箱、套餐/渠道、GPT 状态、OAuth、优惠和操作；不恢复客户状态列。
- 有支付渠道时，套餐圆圈保持绿色，圆圈内直接显示 `MOMO`、`GCash`、`iDEAL` 等渠道文字；字体颜色按 V1 渠道规则区分。
- 内部转发邮箱、原始收件地址、支付链接只在详情中出现。
- 管理员最近邮件和验证码进入详情抽屉，不在每行恢复多余“最近邮件”按钮。
- 新账号在上、旧账号在下；停用/归档/回收后维持原顺序。
- iCloud、域名、Auto/API 等是一级工作台入口，复杂筛选保留在二级筛选区。
- 客户邮件页视觉和交互保持现状，只修兼容性问题。
- 桌面与移动端均用 Playwright 截图和真实长邮箱样本验证，不允许邮箱、tag、按钮重叠或撑乱列宽。

### Phase 8：切换和关闭 V1（P0 Gate）

切换前：

1. 生成 V1/V2 最终一致性报告并归档。
2. 暂停业务写入，等待 V1 outbox lag=0、邮件 cursor 追平、运行任务落稳。
3. 备份 V1 文件、V2 SQLite、outbox/cursor、部署 artifact 和配置摘要，并完成一次恢复验证。
4. 对当前授权、历史授权、停用授权、iCloud、域名、Outlook 各抽样验证登录和邮件范围。
5. command router 切到 V2，V1 进入只读兼容模式。

观察期满足以下条件后才停止 V1：

- 连续 7 天无 P0/P1 数据差异或客户邮件回归。
- V2 所有 P0/P1 功能通过，待审查数量只剩有明确业务原因的项目。
- 优惠黄金样本持续正确，unknown/failed 有可追踪原因和重试。
- V2 备份至少完成一次实际恢复演练。
- V1 兼容投影可从 V2 outbox 重建，回滚脚本已演练。

回滚：切回 command router 到 V1 前，先停止新写入，把 V2 观察期事件投影回 V1，校验 revision、账号集合、当前 binding、凭证指纹、出售/授权和邮件截止，再恢复 V1 写入。禁止直接拿旧 `access-config.json` 覆盖新状态。

## 9. 测试与发布门禁

### 9.1 必测用例

- 三代 iCloud 回收，中间一代明确换绑域名，三代 GPT 身份完全隔离。
- 同一 GPT 依次换绑两个邮箱，当前 AT 在 binding 间连续，新 AT 到来后产生版本替换。
- 历史邮箱观察到当前 subject，只记观察、不回切当前 binding。
- 相同本地部分但不同 subject 保持分离。
- 域名精确 TO 不把邮件给同前缀账号。
- 停收只截止目标 binding，新旧客户链接分别看到正确时间窗。
- 营销 Free Trial 邮件不产生 Plus；真实激活/续费/付款证据产生 Plus。
- 优惠响应所有已知形态、无字段、错误账号、多账号、失效 AT、JP 代理故障。
- V1/V2 同 revision 的五大工作台集合对账。
- V1/V2 command 重放、重复事件、乱序事件、Worker 中断恢复。
- 旧客户 token、密码登录、历史邮件、当前邮件、邮件详情兼容。

### 9.2 性能门槛

- 以 10,000 账号、100,000 binding、1,000,000 邮件为基准数据集。
- 管理列表首屏 p95 小于 300 ms，普通筛选 p95 小于 500 ms。
- 禁止列表 SQL 为每一行执行多组相关子查询；改用聚合 CTE、预聚合视图或专用 summary 表。
- 邮件增量同步不因账号数量增长退化为账号数乘邮件数扫描。
- Worker 单轮内存、耗时、队列长度和失败原因必须进入健康报告。

### 9.3 发布门禁

- `npm test`、TypeScript build、前端 build、迁移测试、生产形状 shadow diff 全部通过。
- `dist` 从空目录生成，manifest 覆盖 API 和 Worker 实际加载文件。
- SQLite `integrity_check=ok`、`foreign_key_check=0`、业务不变量审计=0。
- 每次 schema/同步/切换变更都提供修改前备份、迁移报告和可执行回滚。

## 10. 推荐实施顺序

按以下变更集逐个完成和发布，避免再次把大量未验证逻辑堆在一起：

1. 干净构建、API/Worker 同版本发布、审计命令。
2. 正式 schema migration runner 和新增表。
3. 生产副本回填、47/91/5 三类数据修复报告。
4. 独立优惠检测和黄金样本。
5. credential version、当前凭证指针、换绑继承。
6. V1 outbox、V2 增量 consumer、command router。
7. iCloud/域名/Auto/API/暂无 AT 工作台及核心批量操作。
8. 验证码、OAuth 验活、回收、导入/转移。
9. Outlook Free、分享、使用审计等剩余功能。
10. 双端对账、切 V2 单写、观察、停止 V1。

在第 6 步完成前保持 `V2_READ_ONLY=true`。在第 8 步验收前不把 V2 当主力后台。在最终一致性报告和回滚演练完成前不停止 V1。

## 11. 完成定义

本项目不是以“V2 页面看起来像 V1”为完成，而是同时满足：

- V1 所有保留功能有 V2 等价工作流，筛选集合和写入结果有自动对账。
- iCloud、域名、Auto/API、暂无 AT、Outlook 等工作台建立在明确服务端语义上。
- 优惠资格以 JP `/accounts/check` 权威字段判定，错误不再变成假阴性。
- AT/RT 有完整版本链；同身份换绑连续、回收身份隔离、冲突不覆盖。
- V1/V2 共存期间消息和状态通过事件同步，任意时刻只有一个事实写入端。
- 客户旧链接、历史邮件、当前邮件和截止规则在切换前后保持一致。
- V2 可独立备份、恢复、发布、审计和回滚，关闭 V1 不再依赖 V1 的 JSON、进程或邮件索引。
