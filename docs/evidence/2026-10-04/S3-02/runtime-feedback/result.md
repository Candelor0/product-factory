# D-029运行错误反馈与有限启动修复验证

日期：2026-10-04。版本0.10.0，执行者Codex及checkpoint_store、recovery_audit、recovery_ui。实际开始前核对0.9.0的107个工程文件与上轮交付哈希一致；无Git仓库和提交。对应S3-02、S4-01局部能力，不代表完整阶段通过。

## 实现结果

- 生成页面使用原隔离策略在隐藏候选中先观察启动，1200毫秒观察、两次受信活性检查、12秒总截止。失败或取消保留原可见窗口；独立检查不替换窗口，同构建再次打开只聚焦。
- 固定错误分类、版本/计划/产物绑定、原子运行记录、取消/中断、同ID去重与工作台界面已接入。晚到的同版本可见错误不会被较新的隐藏检查遮住；过期源码错误不覆盖当前版本。
- 用户主动运行修复沿用4轮模型、12工具、5构建/检查、180秒及累计额度。实际修改后重新编译并在新隔离窗口观察；启动未复现原错误时零模型调用，记录no_progress/RUNTIME_NOT_REPRODUCED，不能声称已修复原交互问题。
- RepairStore运行修复使用schema 2，旧schema 1可读；RecoveryService额外核对成功修复的启动报告。源码/业务数据/确认与用量分开。浅色中央首页和侧栏布局保留。

## 实际验证

| 命令/检查 | 实际结果 | 证据 |
| --- | --- | --- |
| npm test | 443/443通过，含新增运行存储、协调及修复边界 | [TAP](node-tests.tap) |
| npm run test:runtime-preview | 48项真实Electron通过 | [JSON](../runtime-preview/2026-10-04T01-50-35-331Z/result.json) |
| npm run test:runtime-feedback | 创建31＋重开12，共43项通过 | [日志](electron.log)、[创建](2026-10-04T01-55-26-116Z/runtime-feedback-create.json)、[重开](2026-10-04T01-55-26-116Z/runtime-feedback-reopen.json) |
| npm run test:build | 57项既有真实构建/隔离回归通过 | [日志](../runtime-preview/build-isolation-regression.log)、[详细目录](../../../2026-10-03/S3-01/build-preview/2026-10-04T01-52-32-247Z/) |
| npm run test:recovery | 55项既有恢复回归通过 | [日志](../runtime-preview/recovery-regression.log)、[详细目录](../../../2026-10-03/S3-03/recovery-preview/2026-10-04T01-53-16-981Z/) |
| npm run test:repair | 137项既有有限编译修复回归通过 | [日志](compiler-repair-regression.log)、[详细目录](../../../2026-10-03/S3-02/repair-preview/2026-10-04T01-55-22-635Z/) |
| 类型/格式/构建 | 通过；既有Lucide指令和esbuild回退查找警告不影响退出码 | [格式](format.log)、[构建](build.log) |
| Mac内部包 | 0.10.0，11资源与最终dist一致，原生esbuild 0.28.2可执行、许可齐全 | [打包](package.log)、[逐项核对](package-verification.json) |

Electron模型响应均为合成，经真实ModelService工具往返；真实付费请求0。测试数据只在artifacts独立目录。旧测试脚本沿用旧日期证据根，目录名中的2026-10-04才是本轮实际运行日期，不将历史结果重复计为本轮。

故障矩阵实际覆盖同步异常、React渲染ReferenceError（包含useState参数缺失变量）、未处理Promise、控制台错误、固定资源加载失败、两类无限循环、原生渲染崩溃、后续交互错误、观察回调失败、取消及退出清理。构建隔离回归的指定IPv4/IPv6 STUN/TURN和HTTP/WebSocket/WebTransport/mDNS目标无观测流量，正向对照与ICE发起检查仍成立；不扩大为任意网络旁路结论。

端到端先保留可交互计数器，再提交编译成功但启动ReferenceError的候选；候选被拒绝且旧窗口计数保持。通过工作台修复按钮用两次合成模型请求读/写源码、两次真实构建与启动检查完成修复，再显式打开新预览并点击加一。另注入仅点击触发的错误，验证隐藏检查之后仍能看到该错误，重新启动未复现时显示未验证而非成功；取消/全局互斥、重开不自动收费以及六类磁盘记录字节不变通过。

## 界面证据

已查看[浅色首页](2026-10-04T01-55-26-116Z/home.png)、[1440宽运行错误](2026-10-04T01-55-26-116Z/runtime-issues.png)、[1024宽运行错误](2026-10-04T01-55-26-116Z/runtime-issues-1024.png)。侧栏与中央输入保持，新面板未横向溢出。另保存[启动复查结果](2026-10-04T01-55-26-116Z/runtime-repaired.png)、[修复后计数器](2026-10-04T01-55-26-116Z/preview-repaired.png)。截图不代替用户视觉验收。

## 失败尝试与修正

1. 首次默认沙箱无法监听本地HTTP及启动Electron；按授权使用允许真实桌面/回环的环境重跑。首次Node还包含旧测试把schema 2当未来版本的断言、代理调试时的早期回调fixture错误；分别适配schema 3和更新fixture。保留[原始失败TAP](node-tests-first-sandbox-and-fixture-failures.tap)，最终443项全部通过。
2. 首次集成期React先报泛化渲染类别并立即结束候选，具体ReferenceError来不及入报告，导致[断言失败](2026-10-04T01-49-06-648Z/failure-create.json)。调整受信钩子先发具体类别，新增真实React缺失变量检查；最终观察仍是快速失败，类别不保证穷尽。
3. 独立审查发现旧窗口回调可能被失败候选解绑、后续原生崩溃事件可能被结束标志挡住、手动检查遮蔽晚到错误，以及启动未复现可能被称为修复成功。各自已修正并有磁盘/真实Electron回归。
4. 第一次格式检查发现RecoveryService格式问题；最后格式化后主bundle变化使先前包哈希不匹配，见[保留记录](package-verification-before-final-format.json)。已重新构建打包并核对最终11资源，未把旧包作为交付。早期截图未等滚动结束，最终补拍了可见面板与1024宽截图。

## 交付及边界

[最终0.10.0 Mac内部包](../../../../../artifacts/desktop/2026-10-04T01-58-05-657Z/产品工厂-darwin-arm64/产品工厂.app)，Apple芯片，未做分发签名/公证。本轮未手动打开真实用户数据的新包；隔离真实Electron启动、交互和重开已验，包资源另行核对。

[117个工程文件哈希](source-sha256.json)为本轮接续基线。代码未提交，没有伪造提交标识。运行报告100条/1MiB、修复50条/1MiB、成功构建20份/32MiB、源码40次提交/16MiB等现有限额仍有效，到限拒绝写入，尚无历史轮换。

仅验证当前macOS arm64前端和有限观察；交互自动回放、功能等价、完整Blueprint/worker、生成博客业务持久化/迁移、源码导出、Windows与干净环境均未通过。本轮不代表新增8个SIGKILL边界重测，该证据来自0.9.0。下一项为S3-01/S4-01生成应用持久业务服务及数据保留，后续导出。协议见[运行反馈](../../../../RUNTIME_FEEDBACK.md)。
