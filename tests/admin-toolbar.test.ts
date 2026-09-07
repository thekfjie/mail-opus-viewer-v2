import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainSource = fs.readFileSync(path.resolve("web/src/main.tsx"), "utf8");
const styleSource = fs.readFileSync(path.resolve("web/src/styles.css"), "utf8");

test("多选工具栏是真正的固定浮层并包含刷新", () => {
  assert.match(styleSource, /\.selection-toolbar\s*\{[\s\S]*?position:\s*fixed;/);
  assert.doesNotMatch(styleSource, /\.selection-toolbar-spacer\s*\{/);
  assert.match(styleSource, /@media \(max-width: 1260px\) \{[\s\S]*?\.selection-toolbar \{ left: 210px; right: 20px; \}/);
  assert.match(mainSource, /className="toolbar-refresh"[\s\S]*?\{loading \? "刷新中" : "刷新"\}/);
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
  assert.match(mainSource, /Shift 点击或按住左侧选择点上下滑动可连续多选/);
  assert.doesNotMatch(mainSource, /pending: "内部待凭证"/);
  assert.match(mainSource, /pending: "exclude"/);
  assert.doesNotMatch(mainSource, /next === "pending"[\s\S]*?pending: "true"/);
  assert.match(mainSource, /任务临时邮箱不建立账号映射/);
});

test("V2 展示 V1 同步过来的区域支付渠道文案", () => {
  assert.match(mainSource, /"ph-gcash": "菲律宾 GCash"/);
  assert.match(mainSource, /"id-gopay": "印尼 GoPay"/);
  assert.doesNotMatch(mainSource, /grabpay|GrabPay|菲律宾 GrabPay/);
  assert.match(mainSource, /"pl-blik": "波兰 BLIK"/);
  assert.match(mainSource, /gopay: "GoPay"/);
  assert.match(mainSource, /billingChannelLabel\(item\.billingChannel\)/);
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
  assert.match(mainSource, /<th>当前邮箱<\/th><th>GPT 状态<\/th><th>OAuth<\/th><th>客户状态<\/th><th>操作<\/th>/);
  assert.doesNotMatch(mainSource, /<th>支付检查<\/th>/);
  assert.doesNotMatch(mainSource, /<th>时间<\/th>/);
  assert.doesNotMatch(mainSource, /className="payment-check-toggle"/);
  assert.match(repositorySource, /ORDER BY a\.arrived_at DESC, a\.id DESC LIMIT/);
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
  assert.match(styleSource, /\.copy-preview-dialog textarea\s*\{[\s\S]*?overflow:\s*auto;/);
});

test("移动端支持按住选择点滑动连续多选，关键批量复制操作排在最前", () => {
  assert.match(mainSource, /dragSelection/);
  assert.match(mainSource, /document\.elementFromPoint/);
  assert.match(mainSource, /onPointerDown=\{\(event\) => startDragSelection/);
  assert.match(mainSource, /已选 \{selected\.size\} 个[\s\S]{0,120}className="batch-primary"[\s\S]{0,120}复制选中说明/);
  assert.match(styleSource, /\.selection-handle\s*\{[\s\S]*?touch-action:\s*none;/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.selection-toolbar \{[^}]*bottom:\s*8px;/);
  assert.doesNotMatch(mainSource, /selection-toolbar-spacer/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.admin-main \{ padding:\s*9px 10px 88px;/);
});

test("工作台使用紧凑信息架构和 24 条明确分页", () => {
  assert.match(mainSource, /const PAGE_SIZE = 24/);
  assert.match(mainSource, /query\.set\("limit", String\(PAGE_SIZE\)\)/);
  assert.match(mainSource, /第 \{page \+ 1\} \/ \{totalPages\} 页/);
  assert.match(mainSource, /className={`overview-shell/);
  assert.match(mainSource, /className="overview-toggle"/);
  assert.match(mainSource, /className="quick-filters"/);
  assert.match(styleSource, /\.table-title \{[^}]*position:\s*sticky;/);
  assert.match(styleSource, /\.admin-app th \{[^}]*position:\s*sticky;/);
});

test("移动导航完整网格可达且账号卡片保持紧凑", () => {
  assert.match(mainSource, /sidebar-nav sidebar-nav-all/);
  assert.match(mainSource, /navItems\.map/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?\.sidebar-nav \{ grid-template-columns:\s*repeat\(4/);
  assert.match(styleSource, /@media \(max-width: 700px\)[\s\S]*?tbody tr\.account-table-row \{[^}]*padding:\s*8px 9px/);
  assert.match(styleSource, /\.state-cell > small, \.credential-cell > small/);
});

test("详情按主题折叠并把常用操作前置", () => {
  assert.match(mainSource, /detail-actions detail-quick-actions/);
  assert.match(mainSource, /<details className="detail-group" open>/);
  assert.match(mainSource, /<span>身份与绑定<\/span>/);
  assert.match(mainSource, /<span>支付与试用检测<\/span>/);
  assert.match(mainSource, /<span>生命周期<\/span>/);
  assert.match(styleSource, /\.detail-group > summary/);
  assert.match(styleSource, /\.detail-action-grid/);
});
