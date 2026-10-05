# 受限源码工具协议实验

2026-10-02，D-024；属于S0-03/S2-02的边界验证及S3-01结构化工具子项。实现位于engineering/desktop/src/main/source-*.ts，契约在src/shared/source-contracts.ts。2026-10-03 D-025已接入工作台IPC和模型工具回合，0.6.0增加源码草稿入口；生成应用运行仍未接入。

## 调用与确认绑定

受信协调器先选择`{ projectId, planRunId }`，调用`SourceToolExecutor.prepare()`取得完整已确认需求、页面方案、计划输入/产物哈希、源码版本。保留audience、outOfScope、questions、palette、sections和notes，不用扁平tasks代替完整确认内容；tasks仍为pending/not_run。该输入不是新模型分析结论。

每次`execute(context, request)`重新读取项目和计划：已归档、需求/页面未确认、计划过期或不是当前计划都拒绝，包括历史成功请求的重放。内部工具请求只能包含下列字段，不能覆盖协调器上下文。在线模型只提供function名称和arguments，schemaVersion/requestId由受信协调器封装。

```json
{
  "schemaVersion": 1,
  "requestId": "唯一的小写UUID-v4",
  "tool": "apply_changes",
  "arguments": {
    "expectedRevision": 0,
    "changes": [
      { "operation": "write", "path": "src/app.tsx", "expectedHash": null, "content": "源码文本" }
    ]
  }
}
```

示例UUID是说明占位符，实际请求必须传合法UUID-v4。三个工具如下：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| list_files | 空对象 | 当前源码版本，以及path/sha256/UTF-8字节数；不返回源码全文 |
| read_file | path | 当前版本、该文件原文与SHA256 |
| apply_changes | expectedRevision、changes | revision、previousRevision、changedPaths、replayed |

write使用完整文件文本；新文件expectedHash为null，更新要求现有内容SHA256。delete要求现有文件及其SHA256。不接受重命名、任意patch脚本、Shell、build、安装依赖或网络请求。请求成功仅表示文本事务保存，不代表代码有效或已通过验收。

## 路径和容量

路径是虚拟名称，**从不直接拼接为宿主文件路径**。只允许src下小写ASCII名称和ts/tsx/js/jsx/css/json扩展；目录不得含点，避免文件/目录前缀冲突。禁止绝对路径、反斜杠、点段、百分号编码、设备名、隐藏文件，以及测试、构建配置、脚本、依赖等受保护命名。源码可使用中文与合法Unicode，保持空白，不接收控制字符、非法代理字符或二进制内容。

本轮限额：单文件128KiB、128个文件、源码树2MiB、单次32项修改、工具请求JSON 2MiB、40次提交、完整记录16MiB。实际达到任一上限就拒绝并保留原记录，不能由模型提高额度。历史会占用容量，因此可能先触及记录上限；后续需设计独立历史整理策略，不能静默丢回执。

## 原子记录和重试

真实宿主文件只有项目`source/workspace.json`及同目录的临时文件。schema1绑定projectId，每次commit保存request、requestHash、revision、时间、完整snapshot。读回从空树重演每次修改，验证连续版本、唯一requestId、请求/源码哈希、排序与快照结果；格式或版本异常保留原文件并拒绝继续。

多文件变更先全部校验，再写独占临时文件、fsync、复查原文件哈希与项目状态、rename，随后fsync目录（本机Mac路径）。同requestId及相同规范化输入返回旧回执；即使已有后续版本，也不重新应用旧修改。相同ID而内容、expectedRevision或计划binding不同则REQUEST_CONFLICT。

| 结果 | 含义与下一步 |
| --- | --- |
| SOURCE_CONFLICT | 版本或文件已变化；重新读取，再用新ID提交经过核对的修改 |
| REQUEST_CONFLICT | 请求ID已用于其他输入；不要把它当重试 |
| SOURCE_COMMIT_UNCERTAIN | rename后发生错误，可能已保存；必须用同ID和同内容核对回执 |
| SOURCE_IO | I/O未正常完成；保留现场，同ID重试可避免重复提交 |
| CORRUPT_SOURCE / UNSUPPORTED_SOURCE / MISSING_SOURCE | 停止写入，恢复/兼容处理后再继续 |

工具响应使用固定错误码和消息，不转发原始异常、堆栈、绝对路径或被拒绝的参数。无效requestId返回null。固定消息中的retryable表示是否可核对重试，不承诺下一次一定成功。

## 已验证与仍有的边界

真实磁盘测试覆盖链接、跨项目、批内失败、容量、历史篡改、双实例陈旧读和提交前后故障；五个独立Node进程覆盖保存前/后退出与恢复。详见[证据报告](evidence/2026-10-02/S0-03/source-tools/result.md)。

这仍是单个受信同步写入器的存储协议。rename前复查不能消除恶意同用户进程的并发路径竞争；没有OS沙箱、多进程锁、防完整历史回滚或断电验收。已观察文件消失会停止，但退出期间被外部完全删除且目录变空时，没有独立索引证明旧记录存在。源码不会执行/物化，所以当前验证不证明任意生成代码可安全构建或运行。

下一步做可信模板、固定构建配置、受控物化/构建及有限修复。完整Blueprint分析、差距来源和worker事件协议仍未完成，不能把本实验称为完整分析引擎。

## D-025模型回合与桌面入口

ModelService.toolTurn采用非流式Chat Completion工具协议，保留assistant.tool_calls，再以role:tool及原tool_call_id回传工具结果；DeepSeek明确禁用thinking，不设置JSON response_format，不使用beta strict。当前官方说明已于2026-10-03通过ego-browser核对：[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[API](https://api-docs.deepseek.com/api/create-chat-completion/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)。只接受stop/tool_calls；截断或异常结束、非法JSON、重复ID、超量calls及密钥反射均在执行工具前拒绝。

CodingRunner单次最多4轮请求、12次工具调用、512KiB消息上下文；ModelService每次响应最多4个tool call、max_tokens4096，既有累计模型额度仍生效。每轮及每个工具前再次核对确认版本，每个工具间让出事件循环供取消。网络失败没有自动重试；SOURCE_IO/COMMIT_UNCERTAIN仅同事务ID本地核对一次，不再请求模型。已原子保存的源码不会因取消回滚。

`runs/coding.json` schema1保存最多50条运行元数据（512KiB），包括请求哈希、planRunId、初始源码版本、轮次/工具次数、固定状态及错误码。每条最多12项toolRequests，记录provider call ID的哈希与受信事务UUID，不存参数或模型原文。调用前落盘，可用UUID关联source/workspace.json回执；映射只能追加。请求次数为已尝试回合，不等同供应商计费次数；真实发送量仍以ModelService用量台账为准。

崩溃时磁盘可能保留running；无当前活动运行时，state将其显示为interrupted，不改写磁盘或自动重发。相同请求ID不会重新调用模型；用户再次点击“继续生成源码”使用新ID，从已保存源码开始新回合，不是恢复旧模型上下文。运行意图和源码事务是两份原子文件，并非跨文件数据库事务；异常时保留现场，不伪造完成。

IPC仅暴露generateSource、codingState、codingFile；生成动作受全工作台变更锁保护，取消/只读状态可并行。主进程保管凭据，renderer将源码作为React文本展示。草稿保存不改plan中的pending/not_run。源码配置、构建、业务数据、Shell、任意生成代码执行和外部完整回滚防护仍不在本实现范围。

验证见[D-025报告](evidence/2026-10-03/S3-02/model-coding/result.md)。

## D-026后续构建

0.7.0已将已保存虚拟源码接入可信编译和独立前端预览，源码事务协议保持不变。编译不执行生成配置或安装命令，失败不覆盖旧产物；预览不提供工作台桥接和持久业务接口。详见[构建协议](CONTROLLED_BUILD.md)。本文此前D-024/D-025“不执行”的描述对应当时交付范围。

## 2026-10-03 D-027实施增量

0.8.0有限修复复用本协议的三个工具和原子源码事务，模型接收固定编译诊断，成功以真实BuildService重编译为准。新增独立修复元数据，未开放宿主路径、Shell或新增依赖。详情见[有限修复协议](BOUNDED_REPAIR.md)。
