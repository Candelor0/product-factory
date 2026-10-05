# 产品工厂

面向个人和非技术用户的本地 AI 应用开发工作台，首版目标是用在线模型生成可在本机运行的 Web 应用。

**0.19.0**

[下载 Mac 版（Apple Silicon）](https://github.com/Candelor0/product-factory/releases/tag/0.19.0) · AI功能需自行配置模型Key。当前包未完成Apple分发签名、公证及其他Mac干净安装验证。

首页采用浅色中央想法输入和侧栏项目布局。已实现项目保存/归档、模型配置、需求与页面确认、开发计划、源码生成、受控构建预览、有限编译与启动修复、源码检查点及项目级JSON持久数据。支持源码维护包导出、模型预算、可撤销的应用AI授权、数据备份恢复及受控结构迁移。支持逐项需求差距报告，区分源码线索、技术证据和用户核验。新增“自动开发”，一次操作串联生成、构建、启动检查及一次有限修复；停止保留源码，重开不自动调用模型。

可以描述对现有应用的修改，查看原要求、前后源码版本与文件变化，再检查修改后的候选。后续有限修复会保留原修改要求的上下文。当前优先完成Mac版与核心功能，Windows发布延后。

- [开发与运行说明](docs/DEVELOPER_GUIDE.md)
- [当前状态](docs/STATUS.md) · [任务台账](docs/TASKS.md) · [最新会话记录](docs/sessions/2026-10-05-13.md)
- [仓库说明](docs/REPOSITORY.md)
- [0.5.0改版验证](docs/evidence/2026-10-02/S2-03/idea-entry/result.md) · [工作台视觉规范](docs/design/WORKBENCH_VISUAL.md)：保留已确认布局，具体视觉效果待用户审阅。

[0.19.0验证报告](docs/evidence/2026-10-05/S3-02/core-flow/result.md)记录修改要求在有限修复中的传递、旧记录兼容、确认到开发的桌面路径及Mac包核验。832项Node与397项Electron通过。真实模型实测准备被已有窗口占用挡住，本轮未发起真实调用；启动检查仍不代表业务通过。

[自然语言修改](docs/APPLICATION_MODIFICATION.md) · [自动开发](docs/AUTOMATIC_WORKFLOW.md) · [差距报告](docs/GAP_REPORT.md) · [结构迁移](docs/DATA_MIGRATION.md) · [数据备份](docs/DATA_BACKUP.md) · [AI预算](docs/APPLICATION_AI.md) · [源码导出](docs/SOURCE_EXPORT.md)。

## 文件组织

| 目录 | 用途 |
| --- | --- |
| `docs/` | PRD、技术方案、任务、决策、会话、真实验证证据 |
| `engineering/desktop/` | Electron/React/TypeScript 工程、依赖配置、脚本和测试 |
| `engineering/references/` | 固定版本上游只读参考副本；不进入应用包或版本控制 |
| `artifacts/` | 应用包、打包输入和隔离测试数据；不进入版本控制 |

根目录只放入口、协作规则和忽略配置。真实用户数据保存到系统应用数据目录，不写入开发仓库。

仓库包含源码、测试、锁文件、项目文档和验证摘要。依赖、打包输入、原始测试附件和个人资料保存在本地；Mac构建包通过Release附件提供，不进入Git历史；历史报告中的本地附件链接不随仓库提供。

本地运行：进入 `engineering/desktop`，依次执行 `npm ci`、`npm run build`、`npm start`。

## 接续开发

先读 [STATUS](docs/STATUS.md)、[TASKS](docs/TASKS.md)、[DECISIONS](docs/DECISIONS.md)，再按当前任务读 [PRD](docs/PRD.md)、[技术方案](docs/TECHNICAL_DESIGN.md)、[阶段手册](docs/DEVELOPMENT_PLAN.md) 和 [验收矩阵](docs/ACCEPTANCE.md)。

任务状态只以TASKS为准。真实模型JSON与工具正常路径已实测；完整上游分析管线、真实模型完整案例及Mac正式分发和干净安装仍待完成。开发机通过不能替代干净环境验收；Windows保留为后续独立任务。
