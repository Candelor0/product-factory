# D-025 模型源码草稿验证

2026-10-03；执行者Codex，source_store与source_boundary_review协作。版本0.6.0，Mac arm64。没有Git仓库或提交；工程指纹见[source-hashes.json](source-hashes.json)。

## 实现与范围

开发计划新增生成源码草稿及折叠的只读文件视图。ModelService工具传输连接受信CodingRunner，读取完整已确认版本，通过三个受限工具保存虚拟源码。每次主动生成最多4轮请求/12工具，仍受既有累计额度限制；取消后阻止后续副作用，已提交源码保留。运行意图和工具事务ID映射落在runs/coding.json，不保存原始模型消息、工具参数或Key。

重开后无活动的running记录显示interrupted，不自动重发付费请求；“继续生成源码”是新请求，从保存的文件重新读取。源码作为文本保存，不物化、不构建、不执行；计划任务pending/验收not_run保持原样。

实现：src/main/model-service.ts、coding-runner.ts、coding-store.ts、coding-tool-schema.ts、app/preload；src/shared下工具/运行契约；renderer/CodingPanel、PlanPanel、App/api与coding.css。首页的浅色中央输入/侧栏历史保持不变。

## 验证结果

| 检查 | 实际结果与证据 |
| --- | --- |
| Node完整回归 | 248/248，原195+模型工具20+运行存储15+协调器18；[原始TAP](node-tests.tap) |
| 新源码Electron双进程 | 创建30+重开14=44项，合成Key/mock fetch；[创建](../2026-10-03T00-56-00-118Z/coding-create.json)、[重开](../2026-10-03T00-56-00-118Z/coding-reopen.json) |
| 原工作台回归 | 创建25+重开18=43项；[最终日志](desktop-regression-final.log)，目录为docs/evidence/2026-10-02/S1-01/2026-10-03T01-02-38-951Z（旧脚本父日期未改，真实执行日期为10-03） |
| 开发计划回归 | 创建34+重开14=48项；[日志](plan-regression.log)，目录为docs/evidence/2026-10-02/S2-02/2026-10-03T01-02-10-303Z |
| 静态与构建 | 类型、全工程格式检查通过；[构建日志](build.log)。Lucide已有use-client提示保留，不影响纯客户端构建 |
| 真实DeepSeek | 4次请求，3次工具调用，2次源码事务，2个文件保存；输入12,739/输出1,503，共14,242已知token，未知用量0；[元数据](live/result.json) |
| 内部Mac包 | 0.6.0，8个构建资源逐文件一致、上游MIT包含；[包核对](bundle-check.json)、[打包日志](package.log) |

Electron验证实际点击计划与源码按钮，经IPC、ModelService模拟响应到磁盘：包括多轮原ID回传、全局变更互斥、切换项目后仍可取消、迟到供应商返回不写入、纯文本/XSS不执行、错误IPC来源拒绝、重开源码/运行记录/计划字节一致与调用数不增加。测试壳页脚44.5.1是Electron版本，不充当0.6.0包证据。

主代理复核[首页1440](../2026-10-03T00-56-00-118Z/coding-home-1440.png)、[源码1024](../2026-10-03T00-56-00-118Z/coding-draft-1024.png)；协作代理另看1440/1024源码图。页面无横向溢出，长源码在独立文本区滚动。没有声称此为用户美学验收。

真实调用使用已保存的官方DeepSeek连接与原累计额度，未读取或输出Key；仅新建“工具实测 · 计数器”，测试程序确认合成需求/页面。记录证明原有项目清单哈希及额度未变。未新增余额充值、未更改模型设置。脚本tests/coding-live-smoke.ts需显式FACTORY_LIVE_CODING=1，不在npm test或test:coding中自动运行。

## 打包版原生复核

以绝对路径启动：artifacts/desktop/2026-10-03T00-59-07-518Z/产品工厂-darwin-arm64/产品工厂.app。CUA读取到本包app.asar实际URL和0.6.0页脚；打开“工具实测 · 计数器”→开发计划，显示源码已保存、4/4轮、3/12工具、2文件/版本2；展开并选择src/app.tsx，实际可读React计数器源码。当前窗口已停留在这一页，未再点击生成。

旧包退出时AX读取超时，随后应用清单确认其isRunning=false，再启动受限实测；没有强制杀死用户进程。此项仅核实实际换包、项目重开和文本查看，不代替完整安装验收。

## 修正与限制

新增协调器最初使用了不匹配的模型错误码；独立审查发现并改为真实错误码，补KEY_REQUIRED/TIMEOUT/CANCELLED与网络/额度断言。工具关联由稳定内存ID补为持久哈希/UUID映射。编写时修正测试UUID类型推断；桌面原有“等待开发引擎”文案断言随新入口更新后针对最终构建重跑43项通过。没有删除失败证据或将计划测试记为通过。

这不是完整应用生成验收：未执行生成代码、未验证真实供应商故障矩阵、完整Blueprint分析/worker、构建修复、任意生成代码系统沙箱、数据迁移、源码导出、Windows、干净Mac、签名公证。running→interrupted是读取时显示，不是自动恢复模型上下文。运行日志和源码是独立原子文件，不宣称跨文件事务、断电保证或防同用户恶意并发/历史整体回滚。

下一步补可信模板、固定工具链与受控物化/候选构建，再接有限修复；S3-02保持进行中，S3及首版整体不标完成。
