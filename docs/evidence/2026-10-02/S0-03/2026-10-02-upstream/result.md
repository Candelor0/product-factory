# S0-03 上游复用核实

执行者：Codex / upstream_audit。实际执行日期：2026-10-02。范围：固定上游版本、仓库许可、源码映射、离线回归和适配建议。此证据只覆盖 S0-03 的一部分；未验证真实模型、worker 打包、双平台运行或产品集成，不能据此完成 S0-03。

## 结论

两个仓库都含明确的 MIT LICENSE，顶层仓库许可没有阻塞本次复用评估。Blueprint 提供可复用的需求分析、规则、差距扫描、阶段缓存和报告能力；starter-kit 提供流程规则和文档模板。两者都不直接提供本项目的桌面自动开发执行器。

建议先保留 Blueprint 的 Python 分析接口作为技术验证候选，通过统一模型服务替换原始 `AnthropicRunner`。暂不整库迁移为 TypeScript，也不以 CLI 文本作为桌面接口。普通博客必须先分流到 Web 规则，避免默认选中 Agent Loop、工具系统等 Agent 专用组件。最终 Python/TS 决策仍取决于 S0-02 打包与边界验证，当前没有跨平台成本实测。

## 固定来源与许可

通过 ego-browser 读取两个 GitHub 仓库页面及许可入口，并用 `git clone --depth 1` 获取当前默认分支源码。只读参考副本位于 `engineering/references/`，与应用代码和本文件分开。两份副本的已跟踪文件均无修改；它们不是产品源码，也不应直接打入安装包。

| 仓库 | 本次观察到的 main SHA / 提交日期 | 仓库许可证 |
| --- | --- | --- |
| [agent-blueprint](https://github.com/hubooooooo/agent-blueprint/tree/776c0fc778f57eb38a63de3a39014bfcf60a43b8) | `776c0fc778f57eb38a63de3a39014bfcf60a43b8` / 2026-09-10 20:53:02 +08:00 | [MIT](https://github.com/hubooooooo/agent-blueprint/blob/776c0fc778f57eb38a63de3a39014bfcf60a43b8/LICENSE)，Copyright (c) 2024 Hubo |
| [ai-product-starter-kit](https://github.com/hubooooooo/ai-product-starter-kit/tree/955871e830e8ec29abfbdee688fff89992fede40) | `955871e830e8ec29abfbdee688fff89992fede40` / 2026-09-15 01:02:10 +08:00 | [MIT](https://github.com/hubooooooo/ai-product-starter-kit/blob/955871e830e8ec29abfbdee688fff89992fede40/LICENSE)，Copyright (c) 2025 hubooooooo |

复用和分发时应在工程的第三方声明中保留对应版权声明及完整 MIT 正文，并登记改动来源。本次未审计每张图片、链接目标或依赖包的许可证；不因此假定所有外部资产均已获分发许可。尚未把任一上游源码、提示词或图片复制进产品可分发目录。

Blueprint 的 `requirements.txt` 固定了 `anthropic==0.123.0`、`python-dotenv==1.2.3`、`pyyaml==6.0.3`，但该文件不是包含全部传递依赖、下载哈希和平台资源的完整分发锁。后续打包仍需独立依赖清单和许可证清单。

## 实际文件到本项目的映射

以下路径相对于对应仓库；固定文件校验值见 [来源清单](upstream-provenance.json)。映射是拟复用接口，不表示已集成。

| 上游文件 | 实际职责 | 本项目适用位置与必要适配 |
| --- | --- | --- |
| Blueprint `blueprint/forward.py` | `run_plan`：提取事实、领域建模、规则选型、设计、审稿，输出 `plan.json` 和方案文档 | S2 需求和方案分析；输出绑定需求版本；不能直接启动编码 |
| `blueprint/reverse.py` | `run_audit`：扫描、意图推断、需求对照、组件差距与审稿 | S4 差距辅助分析；模型判断、静态信号、运行证据必须分别标明 |
| `blueprint/rules.py`、`blueprint/knowledge/__init__.py` | 确定性的特征到 17 个 Harness 组件映射 | 仅用于 Agent 类需求；普通 Web 另用页面、数据、交互和运行验收规则 |
| `blueprint/knowledge/prompts/*.md` | 提取、建模、设计和审稿提示词 | 按适用产品类型选择并登记 prompt 版本；不直接把建议写为用户确认 |
| `blueprint/schema.py` | 输出结构和轻量校验器 | 借鉴事实的「明确/待确认」及 unknowns 表达；产品协议必须补充严格字段与大小限制 |
| `blueprint/pipeline.py` | `StageRunner`、内容摘要、缓存签名、原子文件替换 | 适配阶段恢复；由产品状态库持有权威状态，worker 缓存仅为派生产物 |
| `blueprint/llm.py` | `Runner.complete` 协议、Anthropic 请求、JSON 提取、一次纠错与预算 | 保留协议替换点，改接统一 provider；Key、重试、预算、用量由可信主服务管理 |
| `blueprint/scanner.py` | 静态文件树、依赖和源码正则信号扫描 | 仅扫描已授权项目快照；输出静态证据，不算运行验收 |
| `blueprint/render.py` | Markdown 方案输出 | 可选文档导出层；界面应使用结构化结果 |
| `blueprint/evals.py`、`evals/` | 规则与离线管线题库 | 作为上游行为对照基线；不能替代本项目博客用例或模型实测 |
| Starter-kit `AGENTS.md` | 阶段闸门、追问和证据要求 | 提炼为阶段配置、待确认项和实际验证门槛，不作为覆盖本项目规则的新指令 |
| `docs/PRD/PRD模板.md` | 产品输入字段 | S2 澄清问题和需求输出参考 |
| `docs/手册/AI产品Vibe Coding通用技术栈手册.md` | 技术适配、状态和分阶段开发参考 | 选择适用的需求到任务、验证和恢复规则 |
| `docs/手册/AI产品Vibe Coding通用前端技术栈手册.md` | 页面状态、任务与产物体验、视觉验收参考 | 工作台和生成页面的状态检查；保留等待确认、失败、恢复、部分结果 |
| `docs/手册/AI产品 Vibe Coding 通用上线部署手册.md` | 云发布与账号操作流程 | 首版本地交付不采用其云发布流程，不新增云依赖或外部编码工具依赖 |

## 已核实的技术缺口

1. **产品类型**：`knowledge` 把 s01、s02 标为 `always=True`，`select_components` 恒选两者。原始方案围绕 Agent Harness；直接对普通博客跑全套会加入不必要的 Agent 架构。
2. **模型接入**：`AnthropicRunner.complete` 使用非流式 `client.messages.create`；提示词要求 JSON，然后本地校验并允许一次纠错。它不证明流式、工具调用或官方结构化输出已经兼容。向导中的 DeepSeek 地址是 Anthropic 兼容路径，本次没有调用或确认其服务能力。
3. **密钥和状态**：原始 Runner 读取仓库 `.env` 及进程环境；预算主要在内存对象中累计。桌面产品不能沿用第二套凭据和预算存储，缺失用量不能按零用量向用户报告。
4. **协议**：原始 CLI 输出为文本，未提供产品所需的请求 ID、事件序号、取消确认、跨项目约束和稳定错误类别。
5. **恢复**：阶段签名覆盖输入上下文、提示词、schema、runner/model 和输出摘要，具备复用价值；但产品仍需协调事件落库、文件提交与调用不确定性，不能只凭某个阶段 JSON 存在就认定完成。
6. **静态扫描**：扫描器跳过符号链接和部分目录，但不构成操作系统沙箱；正则命中只说明存在相关文本，不能证明实际权限、数据或恢复行为正确。

## 最小 adapter 协议建议

协议属于后续实现草案，本次没有创建 worker。

```json
{
  "schemaVersion": 1,
  "requestId": "request-uuid",
  "projectId": "project-uuid",
  "runId": "run-uuid",
  "type": "analysis.plan",
  "payload": {
    "productKind": "web",
    "requirementRevision": 1,
    "inputHash": "sha256",
    "providerConfigVersion": 1,
    "resumeFromArtifactId": null
  }
}
```

- `analysis.plan`、`analysis.audit`、`analysis.cancel` 为主服务发出的指令；禁止将任意宿主路径、Shell 或 API Key 作为 payload。
- adapter 将 `Runner.complete` 转成 `model.request`；统一模型服务返回结构化结果与 usage。worker 不自持长期 Key，不自行加载宿主 `.env`，不绕过预算。
- worker 输出 `stage.started`、`stage.result`、`analysis.failed`、`analysis.cancelled`，每条附 request/project/run ID 与单调递增 `sequence`；stdout 只承载 JSON Lines，脱敏日志另通道。
- 产物以 ID、哈希、schema 和来源版本返回。主服务验证后持久化，未知字段、超限输入、错误项目引用和重复事件均拒绝或去重。
- 建议错误类别包括 `invalid_input`、`invalid_output`、`provider_auth`、`provider_rate_limit`、`provider_unavailable`、`budget_exceeded`、`cancelled`、`worker_exit`。未知计费状态单独保存。
- 每项差距标明 `model_assessment`、`static_evidence` 或 `runtime_verified`；没有真实运行证据时不得返回 `runtime_verified`。

## Python 与 TypeScript 比较

| 候选 | 本次可确认的依据 | 尚待验证 |
| --- | --- | --- |
| Python worker | `Runner` 和 `StageRunner` 边界明确；核心 `blueprint/*.py` 共 1,880 行，规则和离线管线能在本机执行；对照上游行为的工作量较小 | 打包解释器、资源和传递依赖；macOS/Windows ABI、取消、主服务模型代理、隔离与安装体积 |
| TypeScript 迁移 | 可与 Electron 主服务共享类型、provider、日志和取消协议；核心规则不依赖大型框架 | 需迁移并对照规则、schema、缓存签名、扫描器、报告和题库；尚未实现，无性能或准确率数据 |
| 直接 CLI 透传 | 可快速做离线实验 | 文本协议、双状态源和密钥处理不符合产品约束，不建议作为正式接口 |

当前建议为「保留 Python 候选，先冻结产品侧 adapter 契约」，不是冻结 Python 技术选型。普通 Web 的澄清与页面方案可以由统一 provider 和新 schema 实现，不能因此声称已经完成 Blueprint 集成。

## 实际验证记录

运行目录：`engineering/references/agent-blueprint`。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m blueprint eval
```

实际环境为 macOS 上的 Python 3.9.6；退出码为 0。上游 3 个正向规则题、3 个 mock 正向管线题、2 个 mock 反向管线题全部通过。原始输出见 [离线回归日志](upstream-offline-eval.txt)。这是离线规则与模拟管线结果，没有模型网络调用、token 用量或费用。上游 README 声明 Python 3.10+；本次部分离线路径在 3.9.6 成功不用于降低其完整运行要求。

另核对两个克隆的 `git rev-parse HEAD`、提交日期、LICENSE、选中文件 SHA-256 和已跟踪状态；结果见 [来源清单](upstream-provenance.json)。本次不安装上游依赖、不运行真实模型、不运行教程中的工具执行示例。首次日志输出路径不存在，修正目录后才执行上述成功回归；没有把该路径错误计为产品测试。

下一步：S0-02 明确运行资源和安全边界后，用同一份 Agent 需求做原始 Runner 与桥接 Runner 对照；增加普通博客不强加 Agent 组件的适配测试；取得用户提供的有效模型凭据后再验证 DeepSeek 流式、格式失败、用量、限流、取消和恢复。worker 打包与真实调用尚未完成，S0-03 保持待后续验证。
