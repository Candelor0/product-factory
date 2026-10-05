# 0.2.0 博客运行底座验证

日期：2026-10-02。执行者Codex；blog_store实现存储及关闭保护，blog_template实现模板，runtime_review审查HTTP边界并编写实测。对应S0-02、FR-001/006/007、NFR-003/004、AC-001/009/014的局部证据，依据D-019。

## 结果与实现范围

本机Mac上的固定博客模板运行实验通过。工作台新增「运行样例」入口，可启动/打开/停止当前项目的博客，创建和编辑文章、保存草稿、本地发布、按标签浏览。保存的数据在停止再启动及完整工作台进程退出重开后保持一致。原需求/方案阶段不因运行样例改变。

这是随包固定模板，不是AI编码成果。未接入任意生成后端、构建执行器、源码导出、Blueprint worker或自动修复；不以此关闭S0或S4完整出口。

应用版本0.2.0、模板`blog-sample-v1`、文章schemaVersion 1；环境macOS 15.7.7 arm64，开发Node22.23.2，Electron44.5.1。无Git提交，37个工程文件哈希见[source-hashes.json](source-hashes.json)。文档在docs，源码/模板在engineering/desktop，包与合成运行数据在artifacts。

## 实现边界

- 每项目`data/blog/articles.json`保存文章，原子临时写入、fsync、rename；revision拒绝过期覆盖，损坏/非法版本不静默清空。标题160、正文60000字符，标签20×32，最多1000篇、总JSON 8MiB。仅受信任单协调器写入，不承诺外部进程同时改文件的事务保障。
- 服务由Electron受信任主进程提供，只监听随机回环端口。API固定为文章读取/创建/编辑，不接受客户端指定文件路径或项目ID；静态资源固定三文件映射。
- 随机会话凭据由专用session仅向当前webContents、精确origin请求注入，不进入URL、网页、返回数据或日志。服务检查Host、Origin、凭据、方法、请求体大小、请求频率；写前检查项目仍未归档。
- 预览无工作台preload，无Node全局，启用context isolation及renderer sandbox；CSP/会话限制经下面的具体网络用例验证。关闭预览、归档或退出工作台回收监听；未保存文字会先询问，取消后编辑和服务仍保留。
- 桌面退出保护测试调用可注入确认回调模拟“继续编辑/放弃”；触发真实beforeunload和关闭生命周期，但不是人工点击原生弹窗的证据。

## 命令与真实结果

| 检查 | 结果与证据 |
| --- | --- |
| `npm test` | 61/61通过：35项原有测试、12项博客存储、14项真实回环HTTP；[输出](node-tests.txt) |
| `npm run test:desktop` | 原工作台21+16=37项通过；[输出](desktop-tests.txt)、[创建记录](../../S1-01/2026-10-02T04-17-07-059Z/desktop-create.json)、[重开记录](../../S1-01/2026-10-02T04-17-07-059Z/desktop-reopen.json) |
| `npm run test:runtime` | 新运行测试30+16=46项通过；[创建记录](../2026-10-02T04-16-41-034Z/runtime-create.json)、[重开记录](../2026-10-02T04-16-41-034Z/runtime-reopen.json) |
| 进程外停服核对 | 两阶段父进程在桌面退出后分别验证两个监听均关闭；[创建退出](../2026-10-02T04-16-41-034Z/shutdown-create.json)、[重开退出](../2026-10-02T04-16-41-034Z/shutdown-reopen.json) |
| 类型与格式 | [typecheck](typecheck.txt)、[format](format.txt)通过 |
| 构建与Mac打包 | 构建成功，Lucide use-client提示仍在；[成功打包](package-retry.txt)，包内容与本地构建逐项一致 |

Electron测试以`PATH=/usr/bin:/bin`启动，模型调用0次；所有文章均为合成数据，未操作真实用户appData。验证实际React表单保存、编辑、发布、草稿不展示、标签“全部”独立筛选、HTML作为纯文本、跨项目访问拒绝、无凭据HTTP拒绝、file/外部HTTP/HTTPS/WS失败、导航/新窗口/iframe被拒绝、未保存取消停止/归档/退出、状态与文件重开保留。HTTP用例另含token跨实例/轮换、Host/Origin与预检、路径穿越、未知字段、256KiB声明/流式超限、限流、冲突和中断上传。

截图经实际查看：[博客详情](../2026-10-02T04-16-41-034Z/blog-create.png)、[工作台入口](../2026-10-02T04-16-41-034Z/workbench-create.png)、[重开后的博客](../2026-10-02T04-16-41-034Z/blog-reopen.png)。截图仅辅助布局判断，持久性结论来自真实进程和文件核对。

## 打包产物与待完成项

[产品工厂0.2.0.app](../../../../../artifacts/desktop/2026-10-02T04-18-31-522Z/产品工厂-darwin-arm64/产品工厂.app)，Mac arm64内部包。`app.asar` SHA-256为`5f6eb0cc9e089eb1fcfc26ff4bc974b6bce566a89439f2615a8b76e5127b89bf`。15项包条目，无用户项目、文章、凭据、tests或node_modules目录；核对见[包清单](packaged-app.json)。没有读取真实密钥来做字符串比对。

尝试原生界面打开打包应用时，工具报告Mac锁屏且无法自动解锁。已请用户解锁；当前打包应用的人工界面复核仍待执行，不冒充已打开。源码构建的真实Electron自动测试已完成，包内资源与同一构建相同。

## 失败、修复与限制

- 首次运行检查在iframe断言失败：Electron报`ERR_BLOCKED_BY_CSP`，但frame对象仍可能保留目标URL。修正测试为核对真实加载失败事件，不改弱产品策略。保留[失败记录](../2026-10-02T04-10-16-337Z/runtime-create-failure.txt)；中间38项通过后又加入未保存保护，最终46项为准。
- 复核发现停止使用destroy会绕过未保存保护，现改为原生关闭生命周期和默认继续编辑；session初始化异常也纳入统一服务回收。最终测试验证这些修复。
- 默认执行沙箱不允许HTTP监听，HTTP测试获得执行许可后才通过。首次打包因沙箱网络`ENOTFOUND github.com`失败，见[失败输出](package.txt)；获得网络执行许可后重打包成功，未绕过系统安全设置。
- 本轮只验证固定受信任模板及受测HTTP/WS/file等通道；没有执行任意生成代码，不是完整系统沙箱证明。WebRTC/WebTransport等网络面仍需在生成前端接入前专门验证；参考[Electron WebRequest](https://www.electronjs.org/docs/latest/api/web-request)、[Session](https://www.electronjs.org/docs/latest/api/session)、[WebContents](https://www.electronjs.org/docs/latest/api/web-contents)。
- 非干净系统，无Windows、签名/公证、系统重启、断电恢复、SQLite迁移或正式博客全功能验收。图片/删除、自由后端及导出均未加入该样例；正式博客Q3保持待确认。
