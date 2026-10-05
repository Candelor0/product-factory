# 开发与运行说明

日期：2026-10-05。范围：0.19.0、源码生成、受控预览、有限修复、检查点恢复、项目级持久数据、源码维护包导出、开发token预算、项目文本AI授权、数据独立备份/确认恢复、受控结构迁移、需求差距报告、自动开发连续流程及自然语言修改已有应用。当前优先Mac版，Windows发布按D-037延后。

## 直接审阅

新包：[产品工厂0.19.0.app](../artifacts/desktop/2026-10-05T06-16-52-179Z/产品工厂-darwin-arm64/产品工厂.app)，不需要另外启动Vite。继续采用中央想法输入、侧栏项目与详情折叠，见[视觉规范](design/WORKBENCH_VISUAL.md)。本轮修复要求传递、确认到开发路径、旧记录兼容及包核验见[报告](evidence/2026-10-05/S3-02/core-flow/result.md)。真实模型准备因已有窗口占用而停止，本轮0次调用。未手动用真实数据打开新包，没有分发签名、公证或干净Mac安装验证；Windows已延后。若系统阻止未知应用，不要求关闭系统保护。

首页输入想法，点击开始或Enter创建；Shift+Enter换行，名称自动取想法开头，当前会话切换项目保留未提交草稿。当前可创建/重命名/归档项目，保存和确认需求版本，配置在线模型，生成并确认页面方向。需要在应用的「模型与设置」中填写自己的 Key；不要把 Key 发到聊天、写进项目或文档。连接检测会产生一次模型调用。

没有Key也可创建项目并试用「运行样例」：打开任意未归档项目，切到运行样例，点击启动博客样例；写文章后保存，选择草稿或本地发布。关闭预览、归档或退出工作台会停止服务；未保存文字可选择继续编辑。下次启动同一项目仍可读取已保存文章。

已确认需求和页面方向后，可打开「开发计划」点击「整理开发计划」。无需Key，会保存页面、功能、数据与验收清单及待明确问题；新版本使旧计划过期。高级设置可明确选择普通网页或AI任务型网页，默认普通网页。规则整理成功只代表清单就绪，任务仍待实现、检查仍未运行。

博客样例是固定模板，非当前需求的AI生成成果，不改变需求/页面确认阶段、不调用模型。模型可生成源码并构建前端预览；已接入有限编译/启动修复、项目级JSON持久数据和源码维护包导出；已实现有限JSON结构迁移，完整应用验收和图片能力仍待补齐。

确认需求、页面方向并整理计划后，可点击「自动开发」连续完成源码生成、构建和启动检查，必要时至多一次有限修复。停止会保留已保存源码，重开不自动续费；「检查已有源码并继续」跳过生成，但必要修复仍可能调用模型。结果不确定时「核对原请求」只读原记录。候选启动通过后仍需预览操作和逐项业务核验。[自动开发协议](AUTOMATIC_WORKFLOW.md)。

已有当前计划的源码后，在「修改已有应用」写下不超过2000字的页面或行为调整，点击「修改并检查」。要求会保存在本项目并发送模型；不要填写凭据或个人业务内容。工作台显示原要求、前后源码版本和文件变化，最近历史只读。没有净变化会明确说明，取消或记录不完整时不会误报无变化；已保存源码保留。主要功能、页面或使用对象变化请重新确认需求和页面方向。后续若需要有限修复，原修改要求仍会传给模型；编译和启动通过不代表这些要求已实现。原数据不随源码修改回退，结构变更仍需独立预览确认。[自然语言修改协议](APPLICATION_MODIFICATION.md)。

在当前开发计划下点击「生成源码草稿」，使用已保存的模型连接，最多4轮请求、12次工具调用，计入累计额度。可通过全局停止取消；已保存源码保留，文件默认折叠并只读查看。中断重开不会自动请求模型；「继续生成源码」是新一轮主动调用。源码保存本身不代表计划中的验收通过。[协议](SOURCE_TOOLS_PROTOCOL.md) · [验证报告](evidence/2026-10-03/S3-02/model-coding/result.md)。

保存源码后点击「构建并预览」，使用随包工具在本机编译并打开独立页面，不消耗模型额度。当前支持固定React前端入口；编译失败保留上次成功产物，可再次打开。可关闭预览并重开，但页面临时数据不保留。当前源码构建通过后可点击「打开本地应用」，使用项目独立存储；只有生成代码实现了保存逻辑，文章等内容才会保存。关闭或归档后已保存内容保留，重开工作台不自动启动应用。启动检查使用空临时数据，不读取正式内容；正式应用运行中已提交的写入不会因随后错误自动回滚。详见[数据协议](PERSISTENT_APP_DATA.md)。详细边界见[构建协议](CONTROLLED_BUILD.md)及[验证报告](evidence/2026-10-03/S3-01/controlled-build/result.md)。

构建失败时可点击「自动修复并构建」，需要时调用模型，最多4轮、12次工具、5次构建及3分钟，计入已有总额度。可随时停止，重开不会自动收费续跑；已经提交的源码和旧成功产物保留。成功后点击「打开最新预览」或「打开预览」体验新版本。此按钮处理编译问题，仍需检查实际页面交互。[修复协议](BOUNDED_REPAIR.md) · [验证报告](evidence/2026-10-03/S3-02/bounded-repair/result.md)。

运行检查区域不调用模型，显示固定错误类别和版本。候选启动失败保留旧预览；点击「尝试修复并检查启动」才可能消耗额度，沿用4轮/12工具/5构建/180秒。首次未复现不调用模型，明确显示尚未验证原交互错误；启动观察不等于业务验收。[运行反馈协议](RUNTIME_FEEDBACK.md)。

开发计划中的“源码检查点”可查看历史，选择“查看恢复影响”后确认恢复；它会追加新版本，不更改业务数据。恢复后重新构建才能查看新页面；旧预览保留原内容。中断时先核对已保存提交/产物，再决定是否主动继续模型生成或修复。源码schema 2自0.9.0支持；provider自0.13.0已升级schema 2，应继续使用0.13.0或更新版本。详见[恢复协议](CHECKPOINT_RECOVERY.md)。

在当前计划的源码区域点击「导出当前源码」，使用系统保存对话框选新的ZIP文件，不调用模型。已有文件不会覆盖；程序及当前数据目录不能作为目标。包包含源码、确认文档、依赖锁、文件清单和固定重建工具，默认排除个人业务数据、凭据、日志及缓存。源码/文档中的私人文字仍会导出，疑似凭据命中时会拒绝保存。维护者自备Node/npm按README校验和重建；没有独立启动服务或源码导入UI。详情见[导出协议](SOURCE_EXPORT.md)。

在开发计划的「应用数据备份」中，点击「导出数据备份」另存生成应用的JSON内容，不要求已有开发计划。备份包含个人内容，请自行保管；固定博客样例、源码、凭据、AI授权/账本不包含。可「选择备份并预览」，核对新增/移除/替换的数据项后勾选确认，再「确认恢复数据」。这会关闭持久本地应用并丢弃未保存编辑，将备份整体保存为新的数据版本；源码和AI用量不回退，也不会自动重开。恢复要求同项目/原存储身份/同源码内容、现有数据完整；若预览后有新保存必须重新核对。不确定结果沿同次预览手动核对，过期或重启先检查当前数据。详见[数据备份协议](DATA_BACKUP.md)。

## 开发命令

以下仅面向开发者，不是最终用户的安装要求。在 `engineering/desktop/` 执行：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装开发依赖 |
| `npm run dev` | 启动 Vite 和 Electron；修改主进程后需重启 |
| `npm run build` | 类型检查并构建renderer/main/preload、固定博客、React运行时、本机esbuild与16文件导出工具包 |
| `npm start` | 使用已构建的 Electron 桌面版 |
| `npm run preview:ui` | 浏览器只读 UI 预览，不能保存项目或调用模型 |
| `npm test` | 全量Node检查，实际数量与结果见当前验证报告：存储/源码事务、导出/重建、协议、模型模拟及真实本地HTTP；需允许回环监听 |
| `npm run test:desktop` | 真实 Electron 两次进程启动与 UI/IPC 检查，先 build |
| `npm run test:gap-report` | 差距报告真实React表单、IPC、版本失效、重开与1440/1024布局；仅合成数据 |
| `npm run test:modification` | 自然语言修改、真实页面变化、持久数据、历史/取消/重开和敏感输入边界；先build，仅合成模型 |
| `npm run test:workflow` | 自动开发两进程桌面流程、修复/取消/重开/原请求核对与截图 |
| `npm run test:plan` | 真实计划按钮、版本变化、IPC与两个进程重开，先build |
| `npm run test:runtime` | 固定模板表单/隔离/未保存保护/两进程重开/停服，先build；需回环监听 |
| `npm run test:visual` | 单输入入口/侧栏/草稿、折叠字段、设置用量、键盘与截图检查，独立合成数据；先build |
| `npm run test:coding` | 真实Electron源码草稿入口、三轮模拟工具往返、取消/互斥/纯文本及双进程重开；先build，无真实付费请求 |
| `npm run test:build` | 实际构建按钮、隔离预览计数器、错误保留旧产物、网络负例及双进程重开；先build，需回环监听，无模型请求 |
| `npm run test:repair` | 真实Electron/编译器配合模拟供应商，验证有限修复、上限/取消/预算、旧产物和中断重开；先build，无真实付费请求 |
| `npm run test:runtime-preview` | 48项真实隔离窗口故障检查，固定错误/无响应/崩溃/取消及代理清理；先build，无模型请求 |
| `npm run test:runtime-feedback` | 43项运行反馈UI/实际ReferenceError修复/未复现交互错误/互斥取消/重开；先build，仅合成模型 |
| `npm run test:app-data` | 39项真实ModelService合成工具回合、React表单、数据保存/源码修改回退/归档与两进程重开；先build，无真实模型请求 |
| `npm run test:app-data-preview` | 50项真实Electron临时/持久会话、来源权限、撤销/取消、限额、表单/网络负例；先build |
| `npm run test:export` | 66项真实UI/IPC/ZIP解包校验、取消/互斥/版本变化与两进程重导出；保存位置由可信chooser注入，无真实模型请求 |
| `npm run test:app-ai` | 57项真实Electron授权/撤销/分账/重开/旧未知与UI检查；先build，只有合成供应商 |
| `npm run test:app-ai-preview` | 45项隔离窗口AI路由/来源/限额/取消及临时禁用边界；先build，无真实模型 |
| `npm run test:data-backup` | 69项真实Electron单独数据备份/取消/变化拒绝/确认恢复/重开与隔离；先build，chooser注入合成路径，无真实模型 |
| `npm run test:source` | 合成源码工具与五个独立Node进程，验证提交前/后退出和恢复；无模型、无UI，不需要先build |
| `npm run test:recovery` | 检查点UI/恢复/重编译、业务字节保留与新进程缺失源码拒绝，55项；先build，无模型请求 |
| `npm run test:recovery-process` | 8个真实SIGKILL边界104项，合成模型响应、真实源码/编译/恢复；先build准备工具链 |
| `npm run package:mac` | 本机架构应用包，先 build；不做分发签名、不公证 |
| `npm run format:check` | 检查工程格式 |

本次开发 Node 22.23.2、npm 10.9.8；应用自带 Electron 44.5.1 / Node 24.21.0。工程其他依赖锁于 package-lock.json。Vite 构建会报告 Lucide 的 use-client 指令提示；本项目为纯客户端，无服务端组件边界，构建成功。esbuild JS内含未使用的包查找回退，打包器另报require.resolve提示；实际测试禁止外部JS包加载并精简PATH仍成功，正式工具路径由随包清单校验后指定。

打包下载受阻时，开发者可设置`PRODUCT_FACTORY_ELECTRON_ZIP_DIR`指向已有Electron ZIP目录后运行打包命令。脚本按已安装Electron依赖的checksums.json核验该ZIP，匹配才使用；默认仍通过标准下载流程。这不是产品用户的运行步骤。

## 源码职责

| 路径（相对 engineering/desktop） | 内容 |
| --- | --- |
| src/main/app.ts | 桌面生命周期、IPC 来源/参数验证、并发变更门闩、网络/导航限制 |
| src/main/gap-service.ts / gap-report.ts / gap-evidence-store.ts | 计划逐项差距、源码声明线索、技术证据与版本绑定用户核验，记录原子追加 |
| src/main/project-store.ts | UUID 项目、格式版本 1、原子存储、内容校验、版本与确认失效 |
| src/main/model-service.ts | DeepSeek/自定义连接、系统加密接口、错误与取消、开发调用/token预算及受信应用文本传输 |
| src/main/app-data-protocol.ts / app-data-store.ts / app-data-service.ts / app-data-sdk.ts | 生成应用JSON协议、原子持久存储/有界历史、临时与持久会话及固定前端SDK |
| src/main/app-ai-store.ts / app-ai-service.ts / app-ai-sdk.ts | 项目授权/独立预算、持久意图去重、所属取消与固定文本SDK |
| src/main/data-backup-service.ts / data-backup-protocol.ts / data-backup-file.ts | 生成应用JSON备份、严格文件读取/完整性、预览令牌与同项目原子恢复协调 |
| src/main/blog-store.ts | 每项目原子文章JSON、输入/版本冲突/容量/路径校验 |
| src/main/blog-server.ts | 固定静态资源与文章API、回环Host/Origin/会话凭据/限额 |
| src/main/blog-runtime.ts | 独立预览session、无特权窗口、启动/关闭/未保存保护 |
| src/main/blueprint-rules.ts | 固定上游规则的TS移植；完整MIT在licenses，随包分发 |
| src/main/development-plan.ts / plan-store.ts | 确认版本绑定、纯规则计划、原子派生记录与重开校验 |
| src/shared/plan-contracts.ts | 计划请求、待办、来源与阶段记录 |
| src/main/source-protocol.ts / source-store.ts / source-tools.ts | 内部受限源码协议、虚拟树原子历史/回执、确认版本绑定及完整输入；不执行代码 |
| src/main/workflow-runner.ts / workflow-store.ts | 有界生成/构建/启动/修复编排、原子父流程与精确回执核对 |
| src/main/coding-runner.ts / coding-store.ts / coding-tool-schema.ts | 4轮/12工具协调、原子运行元数据与事务关联、有限接口定义 |
| src/main/source-compiler.ts / toolchain.ts | 虚拟源码编译、依赖/动态导入限制、随包二进制与运行时校验 |
| src/main/build-service.ts / build-store.ts | 计划/源码版本绑定、取消、不可变成功产物、失败保留 |
| src/main/repair-runner.ts / repair-store.ts | 编译诊断、有限模型修复、重编译与严格原子记录；不自动恢复收费操作 |
| src/main/recovery-service.ts / build-run-store.ts | 全历史一致性核对、恢复和构建意图/结果，拒绝无证据重放 |
| src/main/generated-preview.ts | 隐藏启动观察与独立无特权页面、固定类别错误、自定义资源协议和受测网络拦截 |
| src/main/runtime-service.ts / runtime-store.ts | 版本绑定启动记录、晚到反馈、取消/中断及原子存储 |
| src/main/export-service.ts / export-archive.ts / export-security.ts / export-kit.ts | 快照绑定导出、不可覆盖ZIP发布、有限凭据检查和随包工具完整性 |
| templates/export/ / scripts/build-export-kit.mjs | 固定导出说明、验证/重建脚本、锁文件与许可组装 |
| templates/preview/runtime.js | 固定React前端运行时，构建到dist/toolchain |
| src/main/preload.ts | 固定方法白名单；没有任意 IPC、Shell、文件接口 |
| src/shared/contracts.ts | UI 和主进程数据/返回值契约 |
| src/renderer/ | 中文工作台、状态、需求编辑、方案草图、历史与配置 |
| templates/blog/ | 固定React博客界面与CSS，构建到dist/blog；无用户数据 |
| tests/ | 默认自动测试与Electron入口的模型为模拟；coding-live-smoke.ts与repair-live-smoke.ts为显式启用的真实测试，本地HTTP为真实请求 |
| scripts/ | 开发、构建、打包与隔离测试编排 |

## 用户数据

Mac 默认是 `~/Library/Application Support/ProductFactory/`，Windows 按系统 appData 目录下的 ProductFactory 组织，但 Windows 尚未实测。

`projects/<UUID>/project.json`保存项目清单及需求/方案历史；documents、source、data、checkpoints、runs分目录。博客样例文章在`projects/<UUID>/data/blog/articles.json`，包括正文、标签、状态和revision；不覆盖项目文档。应用授权和用量在`projects/<UUID>/runs/app-ai.json`，独立初始化标记为`runs/app-ai.initialized.json`，不保存提示/响应正文。开发计划在`projects/<UUID>/runs/development-plans.json`，最多100版/16MiB，不修改确认或业务数据。生成应用业务数据在data/generated/{identity,state}.json，外层data/generated.initialized.json用于识别初始化后目录缺失；与固定博客数据分开。源码在source/workspace.json保存虚拟文件树与历史，运行元数据在runs/coding.json；自动开发父流程在runs/workflows.json（50条/2MiB；首次修改升级schema2，明文保存有界用户修改要求），身份标记runs/workflows.initialized.json；修复元数据在runs/repairs.json，最多50次/1MiB；构建尝试在runs/build-attempts.json，最多100条/1MiB；成功构建在runs/builds.json，最多20份/32MiB；运行观察在runs/runtime-reports.json，最多100条/1MiB；并未生成宿主src目录。`credentials/provider.json`保存加密密钥材料、连接配置和用量，预览没有访问它的接口。Electron缓存也在应用数据目录。合成测试数据在artifacts下的smoke、runtime-smoke、plan-smoke、visual-smoke、coding-smoke、build-smoke、repair-smoke分目录。2026-10-03真实工具测试新建“工具实测 · 计数器”，已保存源码；0.7.0构建该草稿；0.8.0另建“修复实测 · 计数器”验证缺失模块修复，原有项目文件未变。

博客每篇标题160、正文60000字符、标签最多20个且每个32字符；1000篇、总JSON8MiB。JSON方案是当前实验，不代表SQLite迁移已完成。停止不会删除已保存文章；保留目录后才能恢复文章，固定博客样例暂无独立数据导出或恢复UI。生成应用JSON另有工作台备份与确认恢复入口。

不要手动改清单中的历史内容；内容哈希不匹配、格式版本未知、路径链接异常会停止读取且保留文件。源码首次恢复会原子升级schema 1→2；首次运行修复升级repairs schema 2；首次打开持久应用升级runtime-reports schema 2，0.13.0启动模型服务时再将provider升级schema 2，应继续使用0.13.0或更新版，0.15.0新增业务JSON结构迁移，首次带结构初始化或迁移会升级data/generated/state.json为schema2，应使用0.15.0或更新版；0.18.0首次自然语言修改原子升级workflows为schema2；0.19.0在新修改进入有限修复时原子升级为schema3，应继续使用0.19.0或更新版；旧无标记的修复仍按原请求核对；其他记录没有通用schema迁移工具；损坏不能默认为空项目。备份应用数据目录时，凭据仍受原操作系统账户绑定，不保证跨机器可解密。

## 数据结构更新

开发计划的「应用数据结构」显示当前数据结构及源码需要的版本。遇到不一致，先用「应用数据备份」导出当前数据，再预览迁移；核对数据项变化并勾选后确认。操作会关闭持久应用，未保存的编辑会丢失；保存为新数据版本后需要手动重开。结果不确定时保留原预览并核对同一次请求。

仅在迁移后尚无数据写入、源码已恢复到迁移前结构时，可预览并回退最近迁移。后续写入会关闭此回退入口，避免删除新内容。结构声明和四种有限操作、容量、旧版本与备份兼容见[迁移协议](DATA_MIGRATION.md)。

## 模型与费用边界

当前默认`deepseek-flash`，地址`https://api.deepseek.com`，需求/方案采用非流式JSON，源码生成采用非流式工具回合。官方依据：[模型列表](https://api-docs.deepseek.com/quick_start/pricing)、[JSON输出](https://api-docs.deepseek.com/guides/json_mode)。已有[三次真实JSON实测](evidence/2026-10-02/S0-03/2026-10-02-live/result.md)，2026-10-03另有[4次真实工具请求](evidence/2026-10-03/S3-02/model-coding/live/result.json)，新增14,242已知token，无未知用量；0.8.0另有[3次真实修复请求](evidence/2026-10-03/S3-02/bounded-repair/live/result.json)，新增9,392已知token。以上均不证明流式或供应商完整故障矩阵。

开发预算保留默认30次累计调用限额，可在设置中额外开启累计token限额。调用前持久预留，usage有效时结算；超时/取消/未知保留占用，重启、换模型或移除Key不清零。旧版未知调用缺少预留估计，不能开启token限额，仍可使用调用次数限制。预留不是供应商精确计费上限，当前没有价格配置或金额估算。系统加密不可用时Key仅本次会话有效；不静默写明文。

在开发计划的「应用AI服务」中填写用途和两个额度，明确授权后「打开本地应用」才能调用文本AI；临时预览和自动检查不可用。应用用量独立于开发累计用量，重新授权不清零；修改模型连接/Key或确认计划后需要重新授权，可在工作台撤销进行中的所属请求。发送过的请求仍可能计费，返回晚到结果会被丢弃。生成代码须实际使用固定SDK才具备AI功能。详见[预算与授权协议](APPLICATION_AI.md)。

系统加密的实际保护范围依赖 OS；本轮测试通过的是存储契约及模拟加密，未完成真实 Keychain/DPAPI 故障矩阵。参考 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 下一阶段

0.15.0新增业务结构声明、相邻迁移和无后续写入时的受限回退。0.16.0新增产品工厂需求—实现—验证差距报告，0.17.0串联确认后的生成/构建/启动检查/有限修复。0.18.0接入自然语言修改、精确文件差异与只读历史。0.19.0补齐修改要求在后续编译/启动修复中的传递，以及确认页面后接续开发的提示。下一项继续围绕产品工厂主流程完成真实案例和业务交互核验；博客作为首个验收输入。价格配置、开发调用细分归属、图片、完整Blueprint分析/worker和端到端验收仍待补齐。当前受测前端窗口的隔离范围见[构建协议](CONTROLLED_BUILD.md)，没有验证任意后端、所有网络旁路或完整系统沙箱；Windows按D-037留后续独立验收。


### 需求、实现与验证

开发计划页的同名区域列出页面、功能、数据和验收目标。可筛选未验证、用户通过、未通过、缺少实现及已过期；源码路径只是实现线索，技术检查单独显示。点击“记录用户核验”，先实际操作，再选择结果和关联源码，填写步骤、预期和实际。通过必须关联当前成功构建和至少一个源码文件。

修改需求、源码或重新构建后刷新报告，旧结论会标为过期；表单不会把旧步骤自动绑定到新版本。结果不确定时可按原请求核对，重新编辑会产生新请求。记录不调用模型、不读取业务库；不要填写Key或私人业务内容。协议与容量见[GAP_REPORT](GAP_REPORT.md)。完整自动业务测试和独立报告导出尚未实现。
