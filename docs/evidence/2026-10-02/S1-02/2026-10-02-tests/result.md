# 基础模块与模拟模型验证

执行：Codex，2026-10-02。关联 S1-01/02、S2-01/03，FR-002/003/004/005/009，NFR-003/004/006；覆盖 AC-003/004/005/006/012/014 的部分基础行为。

## 环境与输入

macOS 15.7.7、arm64；开发 Node 22.23.2、npm 10.9.8。非干净系统，无本项目 Git 提交；代码文件与 SHA-256 见 [source-hashes.json](source-hashes.json)。测试使用临时目录、固定需求、假 Key、注入 fetch 与测试用密码学接口，未调用真实供应商，未输入用户 Key。

## 实际命令与结果

在 engineering/desktop 执行：

- npm run format：退出 0，[日志](format.txt)。
- npm run typecheck：退出 0，[日志](typecheck.txt)。
- npm test：退出 0，**35/35 通过**，[完整输出](tests.txt)。

主要证据：项目原子读写和完整重开、中文/空格路径、格式版本与哈希检查、损坏不覆盖、目录穿越/symlink/hardlink拒绝、跨项目revision拒绝、需求变化使旧方案失效；加密接口失败/会话Key降级/删除；API错误分类、取消/超时、长度/JSON/凭据反射拒绝、未知usage、预算重启保留。两项工作流整合检查用模拟响应连通 provider→schema→store→显式确认，错误不覆盖上一版本。

独立审查复现并修复三项缺陷：JSON Unicode 转义反射 Key、累计 token 超出安全整数、网络发送前存储失败误扣调用。修复均有回归用例。

## 限制与判定

通过上述自动化契约检查。模型 JSON、用量与错误均来自模拟，不能当作真实 DeepSeek 兼容性或费用结果；实际 Keychain/DPAPI 加密故障、流式/工具调用、网络供应商差异未验。路径检查不是任意生成代码的系统沙箱。不存在自动编码或博客 CRUD 通过结论。
