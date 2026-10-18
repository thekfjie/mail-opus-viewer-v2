# 界面与截图

README 中的图片由本仓库实际界面生成，使用临时数据库和合成账号。邮件地址、凭证、优惠观察和历史记录都是演示数据，没有访问真实上游。深色总览展示日常检索，详情展示绑定与凭证历史，浅色移动端展示窄屏布局。

## 重新生成

先安装项目依赖并构建前端。截图工具复用本机已经安装的 Playwright 与 Chromium，不会自动下载浏览器：

```bash
npm ci
npm run build
node scripts/test-offline.mjs -- env OPUS_SQLITE_TEST=1 \
  node --import tsx scripts/capture-showcase.ts \
  /absolute/path/to/playwright/index.mjs \
  /absolute/path/to/chromium
```

隔离包装器需要 Linux 的 `unshare`、`mount` 与 `ip`，以及可用的非特权用户命名空间。它创建临时目录、隐藏旧服务路径、禁用外部网络，只启用回环连接；结束时移除演示库。脚本另行拒绝未隔离的数据库配置，并阻止浏览器请求其他来源。不要把它改成读取生产数据再脱敏。

输出：

- `docs/assets/overview-dark.png`：1680 × 1120，账号总览。
- `docs/assets/account-detail.png`：1680 × 1120，账号详情。
- `docs/assets/overview-mobile.png`：430 × 932，浅色移动端。

图片只截取实际视口，未另加不存在的控件或统计。演示观察结果不表示已执行真实资格检查。界面更新后按相同流程重拍；截图属于文档资源，不在每次 CI 中重新生成。

## 仓库呈现

README 按项目介绍、界面、能力、部署、架构和文档安排，参考了 [Uptime Kuma](https://github.com/louislam/uptime-kuma) 与 [Linkwarden](https://github.com/linkwarden/linkwarden) 的阅读顺序。图片与文案使用本项目内容，不使用其他项目的产品截图。

当前能力写在主线文档中；旧方案保留在 `archive/`，实验通过独立分支与 PR 讨论。修复只挑选有具体场景和验证入口的记录，性能数字附测量条件。
