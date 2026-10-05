# D-026：受控构建与隔离前端预览验证

日期：2026-10-03。内部版本：0.7.0，Mac arm64。执行者：Codex及source_store、launch_handoff、source_boundary_review协作代理。关联FR-006/007、NFR-003/004，S3-01、S3-02及S4-01前端预览子项。

## 结论与实现边界

已保存的React源码可在工作台点击“构建并预览”，经固定工具链编译后进入独立窗口，实际计数器交互可用。失败候选保留前次产物与已打开的预览；重启工作台后可主动重开已保存产物。编译成功没有修改开发计划的实现或业务验收状态，不代表完整S3/S4阶段通过。

- 编译入口固定为`src/app.tsx`，源码保持虚拟文本，编译器仅解析内存中的允许文件。支持受控相对引用及指定React模块，运行时由包提供；不读取或执行生成的配置、安装脚本、插件或后端，不依赖系统Node/npm。动态路径、CommonJS加载、宿主路径、越界依赖和CSS资源URL受限。
- 构建产物绑定当前已确认计划、源码版本与哈希。仅保存完整、不可变产物；同请求幂等，不同内容拒绝复用标识。单份JavaScript/CSS合计上限8 MiB，构建记录最多20份、32 MiB；失败不自动删除旧记录。已观察文件失踪、损坏、未来版本、符号/硬链接和身份不符均停止访问。
- 取消或编译等待期间源码、确认版本、归档状态变化，迟到产物不采用。同一仍有效计划下可以明确打开旧源码产物；确认方向变化后不能沿用旧计划预览。
- 生成代码只进入独立、非持久的Electron sandbox renderer，启用context isolation与web security，无Node、preload或工作台桥接。每个预览只提供当前产物的固定内存资源；会话拒绝权限、下载、导航和弹窗。临时状态关闭后不保留，没有接入生成应用的持久数据服务。

工程位于`engineering/desktop`，文档与证据位于`docs`，包和合成运行数据位于`artifacts`。无Git仓库或提交；88个工程源文件的实际SHA-256见[源文件清单](source-sha256.json)，不提供虚构提交标识。

## 实际验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| Node自动测试 | 最终304/304通过，0失败；含真实esbuild编译、产物存储和构建协调器验证 | [最终TAP](node-tests.tap) |
| Electron构建与预览 | create 40项、独立进程reopen 17项，共57项通过 | [创建](../build-preview/2026-10-03T01-42-53-034Z/build-create.json)、[重开](../build-preview/2026-10-03T01-42-53-034Z/build-reopen.json) |
| 源码生成流程回归 | create 30项、reopen 14项，共44项通过；使用模拟服务 | [日志](coding-regression.log) |
| 固定博客运行回归 | create 30项、reopen 16项，共46项通过 | [日志](runtime-regression.log) |
| 类型、格式与工程构建 | typecheck、format:check通过，工程构建成功 | [构建日志](build.log)；格式检查由主代理终端执行 |
| Mac内部包 | 打包成功；11个构建资源逐项哈希一致，原生编译器可执行，依赖许可保留 | [打包日志](package.log)、[资源核对](package-verification.json) |

Electron测试运行于44.5.1 / Chromium 152.0.7977.130。构建测试将PATH限制为`/usr/bin:/bin`，并在运行时通过`Module._load`拒绝Electron及Node内建模块以外的外部JavaScript包；首次构建和独立进程重开后的再次构建均成功，使用包内固定原生编译器。没有将开发机的完整环境等同于干净系统验收。导入列表及拒绝策略见[实际测试包记录](../build-preview/2026-10-03T01-42-53-034Z/smoke-bundle-imports.json)。

本轮自动化覆盖真实加一、减一和归零，源码语法错误后旧产物字节及已打开窗口保留；构建诊断只含允许的虚拟路径、行号及受限消息。预览关闭、替换、归档会清理窗口与对应代理监听器；进程重开不自动构建或执行预览，用户需主动打开。计划任务继续为`pending`，验收继续为`not_run`。

界面证据：[1440工作台](../build-preview/2026-10-03T01-42-53-034Z/build-success-1440.png)、[计数器预览](../build-preview/2026-10-03T01-42-53-034Z/counter-preview.png)、[失败后保留旧预览](../build-preview/2026-10-03T01-42-53-034Z/build-error-preserves-preview.png)、[进程重开后重新构建](../build-preview/2026-10-03T01-42-53-034Z/counter-reopen-rebuilt.png)。

## 网络边界的反例与修正

本轮先做真实本地探针，发现仅设置Chromium离线状态或CSP不能阻止WebRTC：STUN UDP与TURN TCP目标仍收到流量。只禁止非代理UDP仍会有TURN TCP，只设置代理仍会有STUN UDP。因此没有把这些初步配置写成通过。原始结果保留为[离线/CSP反例](../../../../../artifacts/tests/preview-network-probe-2026-10-03/result.json)、[单一策略与组合对照](../../../../../artifacts/tests/preview-network-probe-2026-10-03/result-proxy.json)。

最终组合使用WebRTC `disable_non_proxied_udp`、无DIRECT或回环绕过的固定SOCKS代理拒绝端、严格CSP与请求过滤，并在Chromium启动时阻断非回环主机解析。工作台模型请求使用受信主进程Node网络，另验证Node仍能解析并访问合成localhost服务。独立[SOCKS/DNS探针](../../../../../artifacts/tests/preview-network-probe-2026-10-03/result-socks-dns.json)后，再在实际预览中进行同类验证。

最终`build-create.json`记录：IPv4与IPv6的STUN UDP、TURN TCP均为0；WebTransport、HTTP、WebSocket、beacon、image目标无流量；六个ICE offer确已启动，合成远端mDNS候选确已提交。IPv4 mDNS监听未见对应查询，同时正向多播控制计数为1；Chromium主机解析在本地返回`ERR_NAME_NOT_RESOLVED`，相关NetLog没有DNS事务。Worker通过实际异步错误验证被CSP阻止，窗口、权限、下载也有真实拒绝步骤。

此结果限于五秒本地目标观察及受测网络面：没有抓取所有系统接口的全部数据包，mDNS没有IPv6多播抓包，也没有测试Chromium漏洞或系统沙箱逃逸。不能据此声称任意生成代码具有完整系统隔离保证。

## 已发现问题与保留的失败证据

1. 首次全量Node检查在执行沙箱内有14项因`EPERM`失败，结果为290/304；该次没有写成通过。保留[受限环境日志](node-tests-sandbox-denied.tap)，之后在获准环境实际重跑，最终为304/304。
2. 初始React运行时采用`export *`后缺失`useState`具名导出，出现编译成功但预览无法渲染。实际renderer错误见[失败JSON](../build-preview/2026-10-03T01-39-02-623Z/build-create-renderer-failure.json)，并保留[第一次等待失败](../build-preview/2026-10-03T01-38-09-795Z/build-create-failure.txt)和[后续定位失败](../build-preview/2026-10-03T01-39-02-623Z/build-create-failure.txt)。调整为明确导出后，真实计数器渲染与交互通过。
3. 实际包检查发现原ASAR解包匹配未使编译器落入解包目录，主代理校验原生路径时得到`ENOENT`，已修正为`**/dist/toolchain/esbuild`并重新打包；最终核对可执行二进制及资源哈希，并在真实0.7.0包内完成构建。该失败来自当时工具输出，没有独立持久日志，未另行编造。
4. 首次打包按`esbuild/LICENSE`取许可失败，实际文件为`LICENSE.md`，已修正许可收集路径并重新打包。保留[失败日志](package-license-failure.log)；最终包核对Agent Blueprint、React、React DOM、Lucide、esbuild及Acorn许可均存在。
5. 预览负向测试最初对Worker的CSP拒绝判定失败，见[当次失败记录](../build-preview/2026-10-03T01-42-01-229Z/build-create-failure.txt)。这是测试fixture修正，产品CSP未因此改变：最终测试等待实际Worker异步错误，并同时排除收到消息或仅超时的情况，重新执行57项检查通过。

构建日志仍含Lucide的`use client`打包提示，以及esbuild内部`require.resolve`回退路径提示。后者没有通过删除警告来掩盖：上述禁止外部JavaScript包加载和精简PATH的真实编译、重开检查均通过，证明受测路径未依赖该回退；不将此扩大为所有平台的部署结论。

## 0.7.0包与已保存真实源码体验

内部包：[产品工厂0.7.0.app](../../../../../artifacts/desktop/2026-10-03T01-40-53-841Z/产品工厂-darwin-arm64/产品工厂.app)。主代理通过原生CUA实际退出0.6.0、打开此0.7.0包，核实窗口页面URL和页脚版本；随后在“工具实测 · 计数器”中，对此前DeepSeek已保存的源码版本2点击“构建并预览”，实际操作显示`0 → 1 → 0 → 2 → 0`，并将页面留在前台供用户体验。

这次使用已有源码，新增模型调用0次。前后文件核对显示：已记录的5个旧文件哈希全部相同，只有该测试项目新增`runs/builds.json`。证据为[体验前哈希](live-projects-before.json)与[体验后核对](live-projects-after.json)。此核对覆盖列出的项目清单、源码和运行记录，不宣称对用户全部文件做过审计。

## 未验证与后续

- 仅已验证受控React前端候选构建与预览。源码仍为虚拟记录；自动错误修复、完整博客生成和持久数据服务、成果导出、后端执行未完成。
- 编译通过不等于类型语义检查、业务验收、数据可靠性或正式交付通过。计数器属于小型样例，不能替代真实博客全链路验收。
- S4-01仅前端预览子项开始；完整一键部署/启停、生成应用持久数据和恢复策略仍待实现。S3-01/S3-02及各阶段出口以TASKS为准，本报告不提前标记完成。
- 没有Windows、干净Mac、分发签名/公证、完整平台支持矩阵或恶意本地进程并发验收。存储采用受信单写者协议，不是宿主操作系统沙箱。
- 本轮没有新增付费模型请求或真实供应商失败矩阵验证，也没有获得新的用户美学认可。下一步继续有限构建修复、生成应用数据与交付能力，保留既有阶段依赖。
