# 独立实现与交互复核

日期：2026-10-05。执行者：Codex 协作代理 recovery_audit。范围：D-034 数据结构协议与编译约束，以及主代理实现的迁移服务、项目数据会话、备份 v2 和 schema 2 存储之间的交互。

## 协议与编译验证

新增结构共享类型与严格协议，补充源码编译入口、源码生成提示和导出包 README。结构哈希按规范排序后的定义计算；四种迁移操作只变换副本，全部步骤及目标结构检查通过后返回，不写入项目数据。

[49 项定向测试](protocol-tests.tap)通过，其中结构协议 21 项、现有及新增编译测试 28 项。覆盖未知字段/原型/访问器/敏感键、结构与容量边界、闭合字段和必填类型、相邻版本、四种迁移、冲突保留原值、128 键整体快照，以及未被入口引用的错误声明仍阻断构建。编译错误使用固定诊断，不回显声明正文。[类型检查](protocol-typecheck.log)通过；首轮测试 fixture 的联合类型推断错误已用明确的 JSON values 类型修正，主代理保存的早期 build 日志仍保留该失败。

## 只读交互审查

核对 `data-migration-service.ts`、`app-data-service.ts`、`app-data-store.ts`、`data-backup-protocol.ts`、`data-backup-service.ts` 和 `app.ts`。未发现确定的 P1/P2 阻断问题：

- 持久会话从构建关联源码读取结构，核对源码哈希；每次数据读写继续核对存储结构，旧版无声明或同版本改变字段均不能绕过。
- 迁移预览绑定完整源码快照、项目状态、数据版本/哈希与结构，关闭应用的异步等待结束后重新检查；重复确认核对持久回执，未确认结果不会盲目执行第二次迁移。
- 结构、数据、回执和迁移前检查点同一次原子提交；回退只允许最近一次迁移且其后没有新数据版本，回退本身追加版本。
- 旧备份按无声明结构处理，备份 v2 校验定义及哈希；恢复要求与当前存储结构一致，不能通过恢复降低或移除结构约束。

本段是静态代码复核，不替代真实 Electron、SIGKILL、断电或双平台验收。真实模型调用为 0；包核验另存 `package-static-verification` 和 `package-electron-asar-loader` 文件，以实际执行结果为准。

## 最终包独立核验

对 `artifacts/desktop/2026-10-05T03-05-45-701Z/产品工厂-darwin-arm64/产品工厂.app` 核验通过：[静态 JSON](package-static-verification.json)、[静态日志](package-static-verification.log)、[真实 Electron ASAR JSON](package-electron-asar-loader.json)、[探针日志](package-electron-asar-loader.log)。工作区、ASAR 和 Info.plist 均为 0.15.0；28 项 dist 资源逐字节一致，16 项导出工具与外层哈希清单一致，原生 esbuild 0.28.2 实际执行及第三方许可检查通过。

Electron 44.5.1 在独立目录调用实际 `loadExportKit` 读取最终 ASAR，16 项载荷全部匹配，AI SDK 与当前受信源码一致。未启动真实工作台、未访问用户业务数据，模型调用为 0。探针结束后 Electron 已退出。仅核验当前 Mac ARM64 包，未新增签名、公证、干净系统或 Windows 验收结论。
