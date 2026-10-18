import type { MailHealth } from "../../src/shared/mail-health";

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "暂无记录";
}

const blockedLabels = { authentication: "上游鉴权异常", quota: "上游配额限制", query: "只读查询被拒绝", cost: "读取成本保护", other: "上游读取保护" };

export function MailHealthPanel({ data }: { data: MailHealth | null }) {
  if (!data) return <section className="report-panel mail-health-panel" aria-label="收信状态"><p className="muted">正在读取本地收信状态…</p></section>;
  const limits = data.d1.limits;
  return <section className="report-panel mail-health-panel" aria-label="收信状态">
    <header className="workbench-heading"><div><h2>收信状态</h2><p className="muted">仅查看本地状态；点击顶部“刷新数据”更新，不触发上游取件。</p></div><small>北京时间 {time(data.checkedAt)}</small></header>
    <div className="mail-health-status">
      <span className="badge green">V2 独立运行</span>
      <span className={`badge ${data.readOnly ? "yellow" : "green"}`}>{data.readOnly ? "业务写入已暂停" : "业务写入已启用"}</span>
      <span className={`badge ${data.webhook.configured ? "green" : "yellow"}`}>{data.webhook.configured ? "Webhook 接收鉴权已配置" : "Webhook 接收鉴权未配置"}</span>
      <span className={`badge ${data.d1.configured ? "green" : "yellow"}`}>{data.d1.configured ? "D1 按 ID 读取已配置" : "D1 按 ID 读取未配置"}</span>
    </div>
    <p className="muted">配置状态表示本机已具备接收与读取条件；最近邮件事件用于确认实际送达情况。</p>
    {(data.ingestion.failed > 0 || data.d1.blocked) && <div className="page-error" role="alert">
      {data.ingestion.failed > 0 && <span>{data.ingestion.failed} 条事件已停止自动重试，需要检查上游投递或处理状态。 </span>}
      {data.d1.blocked && <span>{blockedLabels[data.d1.blockedReason || "other"]}已触发，当前暂停 D1 请求。</span>}
    </div>}
    {(data.notices.unassigned > 0 || data.notices.pendingReviews > 0) && <div className="page-error" role="alert">
      封号通知中有 {data.notices.unassigned} 封尚未关联账号，{data.notices.pendingReviews} 条归属待核对。已接收不代表已计入账号封禁统计，请查看“待核对”。
    </div>}
    <div className="mail-health-grid">
      <article><h3>邮件事件</h3><dl>
        <div><dt>已处理 / 已接收</dt><dd>{data.ingestion.processed.toLocaleString()} / {data.ingestion.total.toLocaleString()}</dd></div>
        <div><dt>待处理</dt><dd>{data.ingestion.pending.toLocaleString()}<small>其中已尝试重试 {data.ingestion.retrying}</small></dd></div>
        <div><dt>封号通知</dt><dd>{data.notices.total} 封<small>未关联 {data.notices.unassigned} · 待核对 {data.notices.pendingReviews}</small></dd></div>
        <div><dt>处理失败</dt><dd>{data.ingestion.failed.toLocaleString()}</dd></div>
        <div><dt>最近邮件事件</dt><dd>{time(data.webhook.lastEventAt)}</dd></div>
        <div><dt>最近处理成功</dt><dd>{time(data.webhook.lastProcessedAt)}</dd></div>
      </dl><p className="muted">事件按邮件 ID 去重。封禁结果持久保留，正文按 ID 从上游读取。</p></article>
      <article><h3>D1 请求预算</h3><dl>
        <div><dt>最近 1 分钟</dt><dd>{data.d1.minuteRequests} / {limits.perMinute} 次</dd></div>
        <div><dt>滚动 24 小时</dt><dd>{data.d1.dayRequests.toLocaleString()} / {limits.perDay.toLocaleString()} 次</dd></div>
        <div><dt>24 小时读取行数</dt><dd>{data.d1.dayRowsRead.toLocaleString()} / {limits.maxRowsReadPerDay.toLocaleString()} 行</dd></div>
        <div><dt>当前读取</dt><dd>{data.d1.activeRequest ? "1 个请求执行中" : "空闲"}</dd></div>
      </dl><p className="muted">失败请求同样计费入账。全局并发 1，每次最多尝试 {limits.attempts} 次，超时 {limits.timeoutMs / 1000} 秒；单次最多读取 {limits.maxRowsRead.toLocaleString()} 行。</p></article>
      <article><h3>补漏与存储</h3><dl>
        <div><dt>手动补漏</dt><dd>{data.d1.manualBackfillReady ? "时间索引已配置" : "时间索引未配置，保持关闭"}</dd></div>
        <div><dt>单次读取范围</dt><dd>最多 {limits.backfillPage} 封 / 1 页</dd></div>
        <div><dt>补漏时间窗口</dt><dd>最多 {limits.backfillWindowMs / 3_600_000} 小时</dd></div>
        <div><dt>补漏冷却</dt><dd>{limits.backfillCooldownMs / 60_000} 分钟{data.d1.backfillAvailableAt && <small>下次可用 {time(data.d1.backfillAvailableAt)}</small>}</dd></div>
        <div><dt>本地邮件数据</dt><dd>轻量索引与必要业务结果</dd></div>
      </dl><p className="muted">不持久化 raw MIME、正文、HTML 或附件；不轮询上游邮件列表，不缓存邮件正文。</p></article>
      <article><h3>后台任务与限流</h3><dl>
        <div><dt>邮件处理租约</dt><dd>{data.background.mailLeases === "mysql" ? "MySQL" : "SQLite 测试库"} 持久租约</dd></div>
        <div><dt>后台任务互斥</dt><dd>进程内 TaskMutex</dd></div>
        <div><dt>请求限流</dt><dd>{data.background.rateLimiter === "redis" ? "Redis 跨 API 实例共享" : "进程内计数（离线测试）"}</dd></div>
      </dl><p className="muted">Worker 只运行一个实例。持久租约避免重复处理同一邮件，Redis 负责请求计数；组件可用性由就绪检查确认。</p></article>
    </div>
  </section>;
}
