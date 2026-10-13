import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainSource = fs.readFileSync(path.resolve("web/src/main.tsx"), "utf8");
const styleSource = fs.readFileSync(path.resolve("web/src/styles.css"), "utf8");
const accountStatusSource = fs.readFileSync(path.resolve("web/src/account-status.ts"), "utf8");

test("V2 所有默认时间展示统一使用北京时间，底层时间仍保持 ISO", () => {
  assert.match(mainSource, /const BEIJING_TIME_ZONE = "Asia\/Shanghai"/);
  assert.match(mainSource, /function fmt\(value: string\)[\s\S]*?timeZone: BEIJING_TIME_ZONE/);
  assert.doesNotMatch(mainSource, /date\.toLocaleString\("zh-CN", \{ hour12: false \}\)/);
});

test("V2 客户与管理员入口均留在独立服务", () => {
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  const mailNginx = fs.readFileSync(path.resolve("deploy/mail.opus.sryze.cc.nginx.conf"), "utf8");
  const cloudNginx = fs.readFileSync(path.resolve("deploy/cloud.opus.sryze.cc.cutover.nginx.conf"), "utf8");
  assert.doesNotMatch(mainSource, /function CustomerApp/);
  assert.doesNotMatch(mainSource, /className="mailbox-app"/);
  assert.doesNotMatch(styleSource, /\.mailbox-app\s*\{/);
  assert.doesNotMatch(mainSource, /legacyMailbox|https:\/\/cloud\.opus\.sryze\.cc/);
  assert.doesNotMatch(mailNginx + cloudNginx, /127\.0\.0\.1:8789/);
  assert.match(mailNginx, /location \/ \{ proxy_pass http:\/\/127\.0\.0\.1:8790; \}/);
  assert.match(cloudNginx, /location \/ \{ proxy_pass http:\/\/127\.0\.0\.1:8790; \}/);
  assert.match(serverSource, /customer/i);
});

test("后台登录、侧栏和分享头部统一使用信封品牌标识", () => {
  assert.match(mainSource, /function OpusBrand/);
  assert.match(mainSource, /className="opus-brand-icon"/);
  assert.match(mainSource, /<OpusBrand className="admin-login-brand"/);
  assert.match(mainSource, /<div className="sidebar-brand"><OpusBrand/);
  assert.doesNotMatch(mainSource, /brand-mark">O|sidebar-brand-mark">O/);
  assert.match(styleSource, /\.opus-brand-icon::before, \.opus-brand-icon::after/);
});

test("多选工具栏是真正的固定浮层并包含刷新", () => {
  assert.match(styleSource, /\.selection-toolbar\s*\{[\s\S]*?position:\s*fixed;/);
  assert.doesNotMatch(styleSource, /\.selection-toolbar-spacer\s*\{/);
  assert.match(styleSource, /@media \(max-width: 1260px\) \{[\s\S]*?\.selection-toolbar \{ left: 210px; right: 20px; \}/);
  assert.match(mainSource, /className="toolbar-refresh"[\s\S]*?\{loading \? "刷新中" : "刷新数据"\}/);
});

test("刷新不清空选择，复制 AT 与导出按钮不受 loading 锁定", () => {
  assert.match(mainSource, /const refreshPage = async \(\) => \{ setError\(""\); setNotice\(""\); await load\("manual"\); \};/);
  assert.doesNotMatch(mainSource, /const refreshPage = async \(\) => \{[^}]*clearSelection/);
  assert.match(mainSource, /<button onClick=\{\(\) => void copySelectedAccessTokens\(\)\}>复制选中 AT<\/button>/);
  assert.match(mainSource, /<button onClick=\{\(\) => void exportSelected\("txt"\)\}>导出 TXT<\/button>/);
});

test("V2 默认直接多选，任务临时邮箱不进入账号页签", () => {
  assert.doesNotMatch(mainSource, /const \[selectionMode, setSelectionMode\]/);
  assert.match(mainSource, /account-table-row selection-mode/);
  assert.match(mainSource, /onPointerDown=\{\(event\) => startDragSelection/);
  assert.match(mainSource, /event\.shiftKey/);
  assert.doesNotMatch(mainSource, /pending: "内部待凭证"/);
  assert.match(mainSource, /pending: "exclude"/);
  assert.doesNotMatch(mainSource, /next === "pending"[\s\S]*?pending: "true"/);
});

test("V2 展示 V1 同步过来的区域支付渠道文案", () => {
  assert.match(mainSource, /"ph-gcash": "菲律宾 GCash"/);
  assert.match(mainSource, /"id-gopay": "印尼 GoPay"/);
  assert.doesNotMatch(mainSource, /grabpay|GrabPay|菲律宾 GrabPay/);
  assert.match(mainSource, /"pl-blik": "波兰 BLIK"/);
  assert.match(mainSource, /gopay: "GoPay"/);
  assert.match(mainSource, /billingChannelBadgeLabel\(item\.billingChannel\)/);
  assert.match(mainSource, /"vn-momo": "MOMO"/);
  assert.match(styleSource, /\.plan-badge\.channel \{ border: 1px solid #73d9a2;/);
  assert.match(styleSource, /\.plan-badge\.vn-momo \{ --channel-text: #be185d;/);
});

test("V2 不再静默隐藏 Plus 账号的未知渠道", () => {
  assert.match(mainSource, /function billingChannelStatus\(item/);
  assert.match(mainSource, /渠道待确认/);
  assert.match(mainSource, /billingChannelStatus\(item\)/);
  assert.match(mainSource, /billing-channel-unconfirmed/);
});

test("V2 可以单独筛选欧洲 iDEAL，且不排除停用记录", () => {
  assert.match(mainSource, /支付渠道筛选/);
  assert.match(mainSource, /value=\{filters\.billingChannel\}/);
  assert.match(mainSource, /\["eu-ideal", "欧洲 iDEAL"\]/);
  assert.match(fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8"), /filters\.billingChannel/);
  assert.match(fs.readFileSync(path.resolve("src/server/server.ts"), "utf8"), /billingChannel: String\(query\.billingChannel/);
});

test("V2 主列表压缩为核心字段且保持原始到达顺序", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  assert.match(mainSource, /新账号在上、旧账号在下；停用、归档和回收不会改变原始到达顺序/);
  assert.match(mainSource, /<th>邮箱<\/th><th>套餐<\/th><th>存活时间<\/th><th>GPT 状态<\/th><th>OAuth<\/th><th>\{tab === "deactivations" \? "封禁时间" : "试用 \/ 优惠"\}<\/th><th>操作<\/th>/);
  assert.doesNotMatch(mainSource, /<th>客户状态<\/th>/);
  assert.doesNotMatch(mainSource, /className="customer-cell"/);
  assert.match(mainSource, /<span className=\{planBadgeClassName\(item\)\}>\{planBadgeLabel\(item\)\}<\/span>/);
  assert.match(mainSource, /className="alive-cell"/);
  assert.match(mainSource, /暂无账单起点/);
  assert.doesNotMatch(mainSource, /<th>支付检查<\/th>/);
  assert.doesNotMatch(mainSource, /<th>时间<\/th>/);
  assert.doesNotMatch(mainSource, /className="payment-check-toggle"/);
  assert.match(mainSource, /title=\{item\.primaryEmail\}/);
  assert.match(styleSource, /\.account-title strong \{[^}]*text-overflow:\s*ellipsis;/);
  assert.match(repositorySource, /: "a\.arrived_at DESC, a\.id DESC"/);
  assert.match(repositorySource, /filters\.workbench === "deactivations"[\s\S]*?a\.deactivated_at DESC/);
});

test("封禁记录复用本地索引并按北京时间自然日筛选", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  assert.match(mainSource, /\["deactivations", "封禁记录", Ban\]/);
  assert.match(mainSource, /\["today", "当天", overviewData\.deactivatedToday\]/);
  assert.match(mainSource, /\["30d", "一个月", overviewData\.deactivatedThirtyDays\]/);
  assert.match(mainSource, /fmtBeijing\(item\.deactivatedAt\)/);
  assert.match(repositorySource, /beijingDeactivationWindow/);
  assert.match(repositorySource, /a\.deactivation_locked=1 AND a\.deactivated_at>=\? AND a\.deactivated_at<\?/);
  assert.match(serverSource, /deactivationWindow: query\.deactivationWindow/);
  assert.match(styleSource, /\.deactivation-window-tabs/);
});

test("详情使用独立可滚动抽屉，桌面和移动端不再撑开表格", () => {
  assert.match(mainSource, /className="detail-backdrop"/);
  assert.match(mainSource, /className="detail-drawer"/);
  assert.match(mainSource, /className="detail-drawer-scroll"/);
  assert.doesNotMatch(mainSource, /<tr className="expanded-row"/);
  assert.match(styleSource, /\.detail-drawer-scroll\s*\{[^}]*overflow:\s*auto;/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.detail-drawer \{[^}]*height:\s*min\(94dvh/);
});

test("完整复制有固定反馈、全文预览和失败兜底", () => {
  assert.match(mainSource, /interface CopyReceipt/);
  assert.match(mainSource, /setSelectionRange\(0, complete\.length\)/);
  assert.match(mainSource, /if \(!copied\) throw new Error/);
  assert.match(mainSource, /className=\{`copy-feedback/);
  assert.match(mainSource, /完整复制内容/);
  assert.match(mainSource, /joinCopyBlocks/);
  assert.match(styleSource, /\.copy-feedback\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(styleSource, /\.copy-feedback\s*\{[\s\S]*?z-index:\s*1500/);
  assert.match(styleSource, /\.copy-preview-dialog textarea\s*\{[\s\S]*?overflow:\s*auto;/);
  assert.match(mainSource, /copyingAccountId === item\.id \? "复制中…" : "复制"/);
  assert.match(mainSource, /type CopyHandler/);
});

test("移动端支持按住选择点滑动连续多选，关键批量复制操作排在最前", () => {
  assert.match(mainSource, /dragSelection/);
  assert.match(mainSource, /document\.elementFromPoint/);
  assert.match(mainSource, /onPointerDown=\{\(event\) => startDragSelection/);
  assert.match(mainSource, /已选 \{selected\.size\} 个[\s\S]{0,600}className="batch-primary"[\s\S]{0,120}复制选中说明/);
  assert.match(styleSource, /\.selection-handle\s*\{[\s\S]*?touch-action:\s*none;/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.selection-toolbar \{[^}]*bottom:\s*8px;/);
  assert.doesNotMatch(mainSource, /selection-toolbar-spacer/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.admin-main \{ padding:\s*9px 10px 88px;/);
});

test("工作台使用紧凑信息架构和 24 条明确分页", () => {
  assert.match(mainSource, /const PAGE_SIZE = 24/);
  assert.match(mainSource, /query\.set\("limit", String\(PAGE_SIZE\)\)/);
  assert.match(mainSource, /第 \{page \+ 1\} \/ \{totalPages\} 页/);
  assert.match(mainSource, /className="metric-grid" aria-label="账号概览"/);
  assert.equal((mainSource.match(/className="metric-card /g) || []).length, 6);
  assert.match(mainSource, /className="quick-filters"/);
  assert.match(mainSource, /value="third_party_pending_recovery">第三方待恢复<\/option><option value="third_party_registered">第三方注册/);
  assert.match(mainSource, /item\.openAiMfaEnabled[\s\S]*MFA[\s\S]*openAiAuthMethods[\s\S]*邮箱 OTP/);
  assert.match(mainSource, /className="search-field"/);
  assert.match(mainSource, /<SlidersHorizontal size=\{16\}/);
  assert.match(styleSource, /\.admin-app th \{[^}]*position:\s*sticky;/);
});

test("账号概览支持 q 查询参数中的完整加号邮箱", () => {
  assert.match(mainSource, /function initialAccountFilters\(\)/);
  assert.match(mainSource, /accountSearchFromQuery\(window\.location\.search\)/);
  assert.match(mainSource, /useState\(initialAccountFilters\)/);
});

test("移动导航可横滑访问全部入口且账号卡片保持紧凑", () => {
  assert.match(mainSource, /sidebar-nav sidebar-nav-all/);
  assert.match(mainSource, /navItems\.map/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.sidebar-nav \{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?tbody tr\.account-table-row \{[^}]*padding:\s*8px 9px/);
  assert.match(styleSource, /\.state-cell > small, \.credential-cell > small/);
});

test("详情按主题折叠并把常用操作前置", () => {
  assert.match(mainSource, /detail-actions detail-quick-actions/);
  assert.match(mainSource, /detail-summary-grid/);
  assert.match(mainSource, /<details className="detail-group detail-identity-group" open>/);
  assert.match(mainSource, /<details className="detail-group detail-payment-group" open>/);
  assert.match(mainSource, /<span>身份与绑定<\/span>/);
  assert.match(mainSource, /<span>支付与试用检测<\/span>/);
  assert.match(mainSource, /<span>生命周期<\/span>/);
  assert.match(styleSource, /\.detail-group > summary/);
  assert.match(styleSource, /\.detail-action-grid/);
});

test("一级账号列表直接排列一个或多个具体优惠", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  assert.match(mainSource, /item\.promoCampaigns\.map/);
  assert.match(mainSource, /promotionCampaignCompactLabel/);
  assert.match(mainSource, /promotion-tag-list/);
  assert.doesNotMatch(mainSource, /1个月优惠可用/);
  assert.match(styleSource, /\.promotion-tag-list\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(repositorySource, /latest_promo_evidence_json/);
  assert.match(repositorySource, /promotionCampaignIds/);
  assert.match(repositorySource, /campaignValue/);
});

test("批量优惠检测显示实时进度、完成后自动收起并支持掉优惠存疑", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  assert.match(mainSource, /promotion-batch-progress/);
  assert.match(mainSource, /结果会逐条刷新/);
  assert.match(mainSource, /setPromotionBatchProgress\(null\)/);
  assert.match(mainSource, /此提示将自动收起/);
  assert.match(mainSource, /refreshAccountListQuietly/);
  assert.match(mainSource, /promotion-check\/status/);
  assert.match(mainSource, /优惠检测中/);
  assert.match(mainSource, /优惠存疑/);
  assert.match(mainSource, /historicalPromoCampaigns\.map/);
  assert.match(styleSource, /\.status-led\.pulse/);
  assert.match(repositorySource, /ever_promo_eligible/);
  assert.match(repositorySource, /promo_suspicious_override/);
  assert.match(mainSource, /标记可能掉优惠/);
  assert.match(mainSource, /promotionCheckErrorDetail/);
  assert.match(repositorySource, /promotion_check_status/);
  assert.match(serverSource, /void runPromotionQueue\(500\)/);
  assert.match(accountStatusSource, /Plus 已开通，无需检测优惠/);
  assert.match(accountStatusSource, /\["active", "third_party_registered"\]/);
  assert.match(mainSource, /Plus\/停用账号已跳过/);
  assert.match(mainSource, /promotionUnavailableReason \? "无需检测"/);
});

test("V1 常用颜色标记在 V2 列表保留并使用紧凑弹层避免撑爆操作列", () => {
  assert.match(mainSource, /function MarkPalette/);
  assert.match(mainSource, /className=\{`mark-palette \$\{saving \? "is-saving" : ""\}`\}/);
  assert.match(mainSource, /className="mark-palette-panel"/);
  assert.match(mainSource, /patchMarkColor/);
  assert.match(mainSource, /setAccounts\(\(current\) => current\.map/);
  assert.match(mainSource, /markSaveChains/);
  assert.doesNotMatch(mainSource, /onSelect=\{\(color\) => void patchAccount\(item, \{ markColor: color \}/);
  assert.match(mainSource, /<MarkPalette value=\{item\.markColor\}/);
  assert.match(styleSource, /\.mark-palette \{/);
  assert.match(styleSource, /\.mark-palette-panel \{[^}]*position:\s*absolute/);
  assert.doesNotMatch(styleSource, /\.row-actions \{[^}]*min-width:\s*292px/);
});

test("手机导航使用单行横滑，账号操作不会被七色条撑宽", () => {
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.sidebar-nav \{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.mark-palette-panel \{ left:\s*0; right:\s*auto;/);
});

test("折叠侧栏后的平板宽度也切换卡片布局，不保留 980px 表格", () => {
  assert.match(styleSource, /@media \(min-width: 701px\) and \(max-width: 860px\)[\s\S]*?\.admin-app table \{ min-width:\s*0; display:\s*block;/);
  assert.match(styleSource, /@media \(min-width: 701px\) and \(max-width: 860px\)[\s\S]*?tbody tr\.account-table-row \{[^}]*display:\s*grid/);
});

test("V1 手动支付渠道可在 V2 详情直接调整", () => {
  assert.match(mainSource, /className="detail-inline-select"/);
  assert.match(mainSource, /billingChannelOverride: event\.target\.value/);
  assert.match(mainSource, /<option value="">自动识别<\/option>/);
});

test("详情操作使用结构化反馈并迁移 V1 打开邮箱快捷入口", () => {
  assert.match(mainSource, /className="action-result-card"/);
  assert.doesNotMatch(mainSource, /className="secret-box action-result"/);
  assert.match(mainSource, /客户登录邮箱/);
  assert.match(mainSource, /客户接码密码/);
  assert.match(mainSource, /void openCurrentMailbox\(\)/);
  assert.match(styleSource, /\.action-result-card \{/);
});

test("账号行更多菜单可直接打开当前邮箱链接", () => {
  assert.match(mainSource, /const openCurrentMailboxLink = async \(item: AccountSummary\)/);
  assert.match(mainSource, /window\.open\("about:blank", "_blank"\)/);
  assert.match(mainSource, /target\.location\.href = output\.publicUrl/);
  assert.match(mainSource, /onClick=\{\(\) => void openCurrentMailboxLink\(item\)\}[\s\S]{0,100}打开邮箱链接/);
});

test("优惠检测与本机支付方式探测使用独立面板且空 POST 不伪装 JSON", () => {
  assert.match(mainSource, /className="promotion-detection-panel"/);
  assert.match(mainSource, /className="payment-method-panel"/);
  assert.match(mainSource, /可选择无优惠或带 1 month 优惠/);
  assert.match(mainSource, /不创建 PaymentMethod，不 confirm 或 approve/);
  assert.match(mainSource, /\["eligibility_api", "local_extractor"\]/);
  assert.match(mainSource, /代理跟随提炼侧配置/);
  assert.doesNotMatch(mainSource, /选择支付检查 IP 出口/);
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  assert.match(serverSource, /payment-exposure\/api\/reveal/);
  assert.match(serverSource, /Cache-Control", "no-store"/);
  assert.match(mainSource, /options\.body !== undefined && options\.body !== null/);
  assert.match(styleSource, /\.promotion-detection-panel, \.payment-method-panel/);
});

test("批量支付方式探查最多支持24个账号，未开通显示method、已开通只显示账单", () => {
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  const exposureSource = fs.readFileSync(path.resolve("src/server/payment-exposure.ts"), "utf8");
  assert.match(serverSource, /accounts\/payment-exposure-check/);
  assert.match(serverSource, /body\.accountIds\.length > 24/);
  assert.match(exposureSource, /slice\(0, 24\)/);
  assert.match(exposureSource, /routeKeys\.length !== 1/);
  assert.match(serverSource, /body\.routeKeys\.length !== 1/);
  assert.match(mainSource, /批量选择支付 method/);
  assert.match(mainSource, /请选择一个具体 method/);
  assert.match(mainSource, /routeKeys: \[batchExposureRoute\]/);
  assert.match(mainSource, /promoMode: batchExposurePromoMode/);
  assert.match(mainSource, /蓝底表示 1 month 优惠下取得，紫底表示无优惠下取得/);
  assert.match(mainSource, /批量探查 method/);
  assert.match(mainSource, /accountHasBilling\(item\)/);
  assert.match(mainSource, /PaymentMethodChips compact items=\{paymentExposureMethodItems\(item\)\}/);
  assert.match(mainSource, /accounts\/payment-exposure-check\/status/);
  assert.match(mainSource, /billingKnown=\{accountHasBilling\(detail\)\}/);
  assert.match(mainSource, /!billingKnown && <section className="payment-method-panel"/);
});

test("单账号可以直接编辑 AT RT，批量收件开关保持 V1 功能", () => {
  const serverSource = fs.readFileSync(path.resolve("src/server/server.ts"), "utf8");
  assert.match(mainSource, /编辑 OAuth \/ 填写 AT/);
  assert.match(mainSource, /saveCredentialEditor/);
  assert.match(mainSource, /Access Token（AT）/);
  assert.match(mainSource, /credential-modal-backdrop/);
  assert.match(mainSource, /role="dialog" aria-modal="true"/);
  assert.match(mainSource, /setCredentialEditorOpen\(false\)/);
  assert.match(mainSource, /凭证已保存，后台正在更新状态/);
  assert.match(mainSource, /credential-save-feedback/);
  assert.match(mainSource, /runBulk\("receiveDisabled", true\)/);
  assert.match(mainSource, /runBulk\("receiveDisabled", false\)/);
  assert.match(serverSource, /accounts\/:id\/credentials/);
  assert.match(serverSource, /saveAccountCredentials\(accountId, body\)/);
  assert.match(styleSource, /\.credential-editor/);
  assert.match(styleSource, /\.credential-modal-backdrop\s*\{[^}]*position:\s*fixed/);
  assert.match(mainSource, /onCopy\(`\$\{label\} 复制成功`/);
});

test("凭证列区分从未入库与已保存但失效", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  assert.match(mainSource, /item\.hasStoredAccessToken \? "失效" : "无"/);
  assert.match(mainSource, /AT 仍加密保存，可在详情中查看和复制/);
  assert.match(repositorySource, /AT 已保存但已失效/);
  assert.match(repositorySource, /result_status IN \('eligible','ineligible'\)/);
});

test("客户导出使用 V2 本地授权与公共地址", () => {
  const repositorySource = fs.readFileSync(path.resolve("src/server/repository.ts"), "utf8");
  assert.doesNotMatch(repositorySource, /config\.accountAuthority === "v1"/);
  assert.match(repositorySource, /\$\{config\.publicOrigin\}\/#m=/);
  assert.match(repositorySource, /formatCurrentCustomerExportText\(currentEmail, base\.loginIdentifier, publicUrl(?:, credentials)?\)/);
  assert.match(repositorySource, /return fields\.join\(" \| "\)/);
});
