# 0.19.0 核心流程与修改意图验证

执行日期：2026-10-05。执行者：Codex、checkpoint_store、recovery_audit、recovery_ui。关联D-039、S2-03/S3-02/S4-01/S4-02、FR-006/008/012。完整任务状态未改变。

## 基线与改动

开始前逐项核对0.18.0的211工程文件，全部与上轮交付哈希一致。保留0.16.0—0.18.0未提交工作区；Git main/0.15.0仍为fd80130752d9885c3c413f2231c86c378eac2416，本轮没有提交或推送。

实际发现修改后的有限修复缺失原用户要求：修复模型只有旧计划和诊断，可能以撤回用户调整来消除错误。0.19.0让编译和启动修复都接收原要求、父流程ID及修改前源码绑定；父流程执行和历史读取均核对规范子请求哈希。独立repairSource仍只允许v1请求；要求文字留在父记录，子记录只保存哈希等元数据，不增加模型/工具/构建额度。

新修改进入修复之前先持久repairRequestVersion=2标记，workflows原子升级schema3。旧0.18.0修改流程中无标记的v1修复继续使用原字段顺序和哈希；既有标记不能补写、移除或改值。初始化标记及storeId不变。详情见[修改协议](../../../../APPLICATION_MODIFICATION.md)。

确认页面后的旧提示更新为实际能力，沿用唯一“前往开发计划”入口。确认、导航和整理本地计划不会触发付费开发。中央浅色输入首页与侧栏布局保持。

## 已执行验证

| 验证 | 实际结果与证据 |
| --- | --- |
| 全量Node | 832/832，通过；含本轮新增15项（7存储+8修复/编排），不把定向重跑重复计数。[原始TAP](node-tests.tap) |
| 存储定向 | 41/41；含新增schema2→3真实SIGKILL的rename前/后两边界，恢复原子完整、请求重放不变。[TAP](store-tests.tap) |
| 修复/编排定向 | 86/86；ModelService合成请求检查编译/启动两路径、旧v1哈希与0.18旧历史、changed-intent冲突、来源与敏感输入。[TAP](../core-live/repair-intent-tests.tap) |
| Electron | 397项：计划58、主界面43、修改71、自动流程88、有限修复137；含实际UI/IPC、两进程重开和内部v2 IPC拒绝。[汇总](desktop-verification.json) |
| 视觉 | 6张本轮1440/1024截图逐张审阅：首页、确认下一步、计划开发入口；主代理另复核1024确认页。[记录](ui-visual-review.json) |
| 工程 | 格式、类型与构建通过；[格式日志](format-check.log)，类型/构建由实际命令及后续原生测试/包资源交叉核对 |
| Mac包 | 28/28资源与最终dist相同；原生esbuild 0.28.2执行、许可完整；16/16导出工具真实ASAR加载通过。[静态记录](../core-live/package-static-verification.json)、[原生加载](../core-live/package-electron-asar-loader.json) |

Electron脚本沿用历史日期目录，但本轮证据都在2026-10-05T06开头的独立子目录，精确路径和日志SHA见汇总。所有模型响应为合成；真实桌面操作不等于真实供应商生成质量。独立Electron测试宿主截图页脚显示44.5.1，正式包workspace/package/Info.plist均已核对为0.19.0。

早期定向测试85项中2项失败，原因是新增夹具调用不存在的BuildStore.all，随后改用真实BuildService.attempts并增加执行时归属回归；旧日志保留在相邻core-live目录。没有降低产品断言或删用例。构建仍有既有lucide use-client与esbuild require.resolve警告；未出现本轮构建失败。

## 真实模型准备被阻挡

新增显式启用的三阶段驱动，生成/修复共享4次真实请求硬限，沿用既有模型配置和累计预算，不复制或打印Key；独占phase意图禁止自动重跑付费阶段。固定合成需求/页面只用于开发验证，不是正式博客确认。

唯一实际执行的真实配置准备：`FACTORY_LIVE_CORE=1 node scripts/core-live-smoke.mjs prepare`。runId为`2026-10-05T06-16-15-513Z-50389e6d`，在startDesktop获取单实例锁时返回`ALREADY_RUNNING`并退出1，没有发起模型请求、创建测试项目或执行ModelService迁移。没有绕过单实例保护或关闭已有旧窗口。用户已收到正常退出旧窗口的请求，交接时尚未收到回复。

[准备记录目录](../core-live/2026-10-05T06-16-15-513Z-50389e6d/)保留manifest、intent、entered、bundle SHA、固定错误码和runner退出状态。原始stdout/stderr均为0字节。**本轮真实模型调用0；真实生成、业务CRUD与跨进程重开均未运行。** 不能把合成测试写成该实测通过。

现有驱动reopen只收集有限DOM、截图和数据哈希，明确NOT_RUN；以后成功生成后，仍须根据实际页面补真实新增/编辑/删除/重开断言，不能以打开页面替代业务验收。

## 交付与限制

[0.19.0 Mac包](../../../../../artifacts/desktop/2026-10-05T06-16-52-179Z/产品工厂-darwin-arm64/产品工厂.app)。ASAR SHA256：`081d48f0024e4d93e340742cd9eb94cb56c70724c345c1f4ffc14ef839f8423d`。没有手动用真实数据打开新包，没有正式分发签名/公证或干净Mac验收。

213工程文件，相对0.18.0修改16、新增2、无删除；[工程哈希](source-sha256.json)、[变化清单](source-changes.json)。测试和探针均已退出；已有旧ProductFactory窗口保留。

完整真实模型主流程、业务质量、完整Blueprint分析、图片、价格配置/开发调用细分，以及Mac安装和非技术试用仍待完成。Windows按D-037延后。7进行中/8待验证/6未开始不变；测试数量与版本号不换算完成百分比。
