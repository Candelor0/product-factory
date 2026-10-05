# 真实 Electron 桌面检查

执行者 Codex，2026-10-02，运行编号 2026-10-02T03-11-02-880Z。关联 S0-02、S1-01/03、S2-01/03；FR-003/004/005，NFR-003/004；AC-004/005/006/014/020 部分基础行为。

## 环境与版本

macOS 15.7.7 arm64，Electron 44.5.1，自带 Node 24.21.0；非干净系统。无 Git 提交。随后只做 Prettier 格式整理与新增测试，无产品行为修改；本次产品构建相同地打入内部包，包哈希见 [内部包](../../S0-02/internal-package/result.md)。

## 操作与结果

在 engineering/desktop 实际运行 npm run build（退出0）及 npm run test:desktop（退出0）。脚本启动两个独立 Electron 进程，PATH限制为 /usr/bin:/bin，测试目录独立放 artifacts/smoke/运行编号/中文 空格数据。

- 创建进程：**21 项通过**，[机器结果](desktop-create.json)。真实 React 新建表单→preload→IPC→持久化，缺Key错误，版本确认；主renderer无Node、操作系统sandbox指标为真；其他窗口即便挂相同preload也无法调用特权API；路径越界、外部fetch、新窗口、外部导航被拒绝。
- 重开进程：**16 项通过**，[机器结果](desktop-reopen.json)。前一进程项目、需求与页面确认恢复；新需求使旧页面失效；归档/恢复保留项目；UI项目导航及确认提示正确。
- 两进程均检查1440和1024视口无页面横向溢出；检查实际需求表单和页面方向视图。供截图的博客内容是固定测试数据，不是AI生成博客成果。
- 两次均确认模型调用次数为0。

## 可复核截图

- [1440 首页](desktop-create-1440.png)、[1024 首页](desktop-create-1024.png)。
- [需求页面](requirements-create.png)、[页面草案](design-create.png)。
- [需求变化后](requirements-reopen.png)、[阻止旧页面继续](design-reopen.png)。

首次32项检查运行在 ../2026-10-02T03-06-17-867Z，随后发现次要文字过浅、窄窗口字号过小，已加深文字并在1024宽度隐藏右栏，本目录为改进后的复测。浏览器只读预览额外验证设置dialog焦点、password类型、Escape关闭和预览标识；ego screenshot超时未产出图片，未把失败截图列为证据。

## 判定边界

上述Mac桌面行为通过。不能推断干净系统安装、全部跨平台恢复、强杀中断、真实模型质量、生成代码隔离或博客持久业务数据已通过。已有37项检查不是37个完整验收项；S0/S1/S2出口仍有缺口。
