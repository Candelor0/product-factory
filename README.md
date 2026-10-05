# 产品工厂

面向个人和非技术用户的本地 AI 应用开发工作台，首版目标是用在线模型生成可在本机运行的 Web 应用。

**0.15.0**

首页采用浅色中央想法输入和侧栏项目布局。已实现项目保存/归档、模型配置、需求与页面确认、开发计划、源码生成、受控构建预览、有限编译与启动修复、源码检查点及项目级JSON持久数据。支持源码维护包导出、模型预算、可撤销的应用AI授权、数据备份恢复及受控结构迁移。

- [开发与运行说明](docs/DEVELOPER_GUIDE.md)
- [当前状态](docs/STATUS.md) · [任务台账](docs/TASKS.md) · [最新会话记录](docs/sessions/2026-10-05-05.md)
- [仓库说明](docs/REPOSITORY.md)
- [0.5.0改版验证](docs/evidence/2026-10-02/S2-03/idea-entry/result.md) · [工作台视觉规范](docs/design/WORKBENCH_VISUAL.md)：保留已确认布局，具体视觉效果待用户审阅。

[本轮数据结构迁移验证](docs/evidence/2026-10-05/S4-02/data-migration/result.md)：670项全量Node与245项Electron通过（71新增＋174回归），真实模型0次。迁移需明确确认，回退要求迁移后无数据写入且源码已回到原结构；不支持损坏库重建或跨机器迁移。[结构迁移](docs/DATA_MIGRATION.md) · [数据备份](docs/DATA_BACKUP.md) · [AI预算](docs/APPLICATION_AI.md) · [源码导出](docs/SOURCE_EXPORT.md)。

## 文件组织

| 目录 | 用途 |
| --- | --- |
| `docs/` | PRD、技术方案、任务、决策、会话、真实验证证据 |
| `engineering/desktop/` | Electron/React/TypeScript 工程、依赖配置、脚本和测试 |
| `engineering/references/` | 固定版本上游只读参考副本；不进入应用包或版本控制 |
| `artifacts/` | 内部应用包、打包输入和隔离测试数据；不进入版本控制 |

根目录只放入口、协作规则和忽略配置。真实用户数据保存到系统应用数据目录，不写入开发仓库。

仓库包含源码、测试、锁文件、项目文档和验证摘要。依赖、构建包、原始测试附件和个人资料保存在本地；历史报告中的本地附件链接不随仓库提供。

本地运行：进入 `engineering/desktop`，依次执行 `npm ci`、`npm run build`、`npm start`。

## 接续开发

先读 [STATUS](docs/STATUS.md)、[TASKS](docs/TASKS.md)、[DECISIONS](docs/DECISIONS.md)，再按当前任务读 [PRD](docs/PRD.md)、[技术方案](docs/TECHNICAL_DESIGN.md)、[阶段手册](docs/DEVELOPMENT_PLAN.md) 和 [验收矩阵](docs/ACCEPTANCE.md)。

任务状态只以TASKS为准。真实模型JSON与工具正常路径已实测；完整上游分析管线、通用执行/数据边界和双平台安装尚未完成。开发机通过不能替代干净环境或Windows验收。
