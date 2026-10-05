# D-030生成应用持久数据验证

日期：2026-10-04。版本0.11.0。执行者Codex及checkpoint_store、recovery_audit、recovery_ui。实施前核对0.10.0的117个工程文件与上轮交付哈希一致；没有Git仓库或提交。对应S3-01/S4-01/S4-02局部实现，完整阶段仍未通过。

## 已实现

生成前端可导入固定`@factory/data`，通过严格read/apply协议保存项目级JSON。数据与源码、确认、固定博客样例及凭据分离；每次持久请求重新核验内部项目和确认计划。版本比较防止旧数据覆盖，UUID回执核对重复请求，原子初始化/写入保留5份先前快照及256个去重回执。损坏、链接、未来格式和已初始化文件缺失不会默认为空数据。

原预览、启动检查和自动修复使用独立空内存数据。用户显式点击「打开本地应用」时，先临时检查，再创建全新origin/session/window连接持久数据；候选不能升级权限。新打开须匹配当前源码版本及哈希。同产物聚焦不重载；关闭、替换、归档及退出撤销会话。持久窗口在实际加载前显示，实际加载中已提交写入不会因随后失败回滚；保留旧窗口不能推断数据没有改变。

受信数据路由限定主框架、内部一次性许可、POST JSON、体积/频率和生命周期；生成页面没有Node、preload桥接、任意文件/SQL或跨项目选择器。模型只接收固定SDK协议，不读取业务存储。临时预览与本地应用的后续错误通道分开，runtime-reports首次记录application时升级schema 2，需使用0.11.0或更新版。

## 实际验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| npm test | 全量476/476通过，包括数据协议/存储/SDK/会话和4个真实子进程SIGKILL边界 | [TAP](node-tests.tap) |
| runtime-service定向 | 21/21通过，包含全量之后新增的1个旧源码产物拒绝用例；当前477个用例均已执行，不冒称477项全量单次运行 | [TAP](stale-source-targeted.tap) |
| test:app-data | 创建30＋重开9，共39项；真实ModelService合成工具往返、编译器、React表单、磁盘及两个Electron进程 | [日志](electron.log)、[创建](2026-10-04T03-10-47-456Z/app-data-create.json)、[重开](2026-10-04T03-10-47-456Z/app-data-reopen.json) |
| test:app-data-preview | 50项数据传输/权限/临时持久会话边界通过，使用合成文件后端隔离测试传输能力 | [JSON](../app-data-preview/2026-10-04T03-07-42-426Z/result.json) |
| test:runtime-preview | 48项既有真实运行故障/取消/清理回归通过 | [日志](../app-data-preview/runtime-preview-regression.log)、[JSON](../../S3-02/runtime-preview/2026-10-04T03-09-01-269Z/result.json) |
| test:build | 57项既有编译/隔离/重开回归通过 | [日志](../app-data-preview/build-isolation-regression.log)、[详细目录](../../../2026-10-03/S3-01/build-preview/2026-10-04T03-09-45-802Z/) |
| test:runtime-feedback | 43项既有运行修复UI/取消/重开回归通过 | [日志](../app-data-preview/runtime-feedback-regression.log)、[详细目录](../../S3-02/runtime-feedback/2026-10-04T03-11-40-868Z/) |
| 类型/格式/构建 | 全部通过，既有Lucide指令与esbuild回退查找提示保留 | [构建日志](build.log) |
| 内部Mac包 | 0.11.0，11资源与最终dist哈希一致；原生esbuild 0.28.2可执行，许可齐全 | [打包](package.log)、[逐项核验](package-verification.json) |

本轮新增89项Electron和148项既有回归，合计237项。全量Node中的4个SIGKILL为数据目录初始化rename前/后、业务快照提交rename前/后；不是断电实验，也没有重复执行0.9.0的8个源码恢复SIGKILL边界。数据写入已提交时按原requestId核对回执，不重复增加版本。

端到端合成模型3次响应经过真实工具回合保存博客React源码，实际编译并由页面按钮保存标题、草稿状态和标签。临时试写没有创建业务目录，正式数据和临时数据相互独立；关闭重开、工作台新进程重开、样式迭代、源码检查点恢复、归档/解除归档后state.json哈希保持。旧源码构建不得重新打开持久应用，失败临时候选不能删除正式文章，其他项目读取空数据。源码、计划、项目与业务文件新进程哈希一致；计划任务仍为not_run，不以本测试替代业务验收。

真实付费模型请求0；所有新数据在artifacts独立测试目录，未修改用户真实项目。测试中业务内容不进入模型请求；模型调用发生在首次写业务内容之前，随后打开/检查/迭代/恢复不发模型请求。源码静态复核进一步确认生成/修复路径没有读取业务数据的接口；不将零后续请求冒称真实数据上传场景已测试。

网络实探中，受信HTTP正向探针可达；生成窗口HTTP/WebSocket/beacon/image/原生form外发无流量。既有构建矩阵的指定IPv4/IPv6 STUN/TURN、WebTransport、HTTP/WS/mDNS目标均0，mDNS正控1、6个ICE offer已发起且IPv6可用。仅适用于当前Mac/Electron与受测目标，不宣称穷尽所有旁路或完整系统沙箱。

## 界面与失败修正

已查看[1440宽工作台](2026-10-04T03-10-47-456Z/workbench-application.png)、[1024宽工作台](2026-10-04T03-10-47-456Z/workbench-application-1024.png)及[保存后的合成博客](2026-10-04T03-10-47-456Z/persistent-blog.png)。浅色与侧栏布局保持，本地应用按钮/状态可见；1024无水平溢出。首页结构未修改，本轮没有新增首页截图或用户视觉验收。

1. 正常React form点击保存超时，输入已更新但submit处理器没有进入，保留[第一次](2026-10-04T03-02-04-894Z/failure-create.json)及[诊断](2026-10-04T03-04-10-277Z/temporary-form-diagnostic.json)。在独立预览矩阵也复现[同一失败](../app-data-preview/2026-10-04T03-07-00-604Z/failure.json)。原因是原CSP sandbox未允许forms；仅补allow-forms并继续保留form-action none、opaque origin及导航/网络拒绝。最终真实submit事件和原生外发负例均通过。
2. 边界测试[02:59失败](../app-data-preview/2026-10-04T02-59-21-728Z/failure.json)误认为合法主框架携带伪造头必须拒绝；实际主进程覆盖该头且权限仍绑定原项目，改为验证无法取得跨项目权限，未放宽鉴权。[03:00失败](../app-data-preview/2026-10-04T03-00-08-007Z/failure.json)误认为Worker受CSP拒绝必同步抛错；改为观察异步error、无Worker消息及无iframe执行消息，保留原策略。最终50项通过，不将早期失败删除或计入通过。
3. 独立复核发现持久应用不应复用临时预览可显式打开旧产物的策略。已在IPC和RuntimeService两层拒绝过期源码产物，补21项定向中的新增用例及真实IPC回归；旧运行窗口与数据保留。最终源码复核无新的P1/P2发现，该审查不冒充运行测试。

## 交付与剩余

[0.11.0 Mac内部包](../../../../../artifacts/desktop/2026-10-04T03-11-59-851Z/产品工厂-darwin-arm64/产品工厂.app)，Apple芯片。没有分发签名/公证，本轮未手动打开真实用户数据的新包；隔离真实Electron与包资源分别核验，不等于干净安装或原生交接验收。

[130个工程文件哈希](source-sha256.json)及[相对0.10.0的文件清单](source-changes.json)为接续基线；无Git仓库、无提交。本轮增加13个工程文件，修改21个，文档/工程/构建产物分目录保存。

业务JSON当前1MiB/128键、单值128KiB/深度16/节点2万、单次32项修改；记录8MiB、历史5份、回执256条。没有数据恢复UI或通用迁移；如果外部删除包含初始化标记的整个data目录，新进程无法辨认旧数据存在。其余源码/构建/修复/运行记录容量仍按原限额，到限拒绝新增，未加入历史轮换。

S3-01/S4-01/S4-02继续进行中，S3-03待验证，总计6进行中、8待验证、7未开始。完整生成博客CRUD/图片、数据结构迁移、完整Blueprint分析/worker、任意交互回放、Windows/干净环境和全链路业务验收仍未完成。下一项S4-03源码导出，默认排除业务数据和凭据。详见[协议](../../../../PERSISTENT_APP_DATA.md)。
