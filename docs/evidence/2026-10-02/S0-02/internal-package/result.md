# Mac 内部应用包检查

执行：Codex，2026-10-02。关联 S0-02，FR-001/011，AC-001/016的可行性部分。

## 产物与操作

- 在工程目录 npm run build 退出0；npm run package:mac 使用 @electron/packager20.3.0、Electron44.5.1 构建darwin-arm64，退出0。
- 输出 artifacts/desktop/2026-10-02T03-11-20-772Z/产品工厂-darwin-arm64/产品工厂.app。
- 用系统 open -n 打开该.app，退出0；之后通过本机辅助功能工具实际读到应用窗口“产品工厂 · 让想法成为作品”、空项目列表、新建项目、模型与设置等完整界面，确认加载来自包内 app.asar/dist/renderer/index.html。没有创建用户测试项目或填写密钥，窗口保留供用户审阅。
- [包内容与SHA-256](package-inspection.json)：仅构建代码、静态资源、package.json与第三方许可；无测试、上游参考、凭据。Electron本体随包提供。
- 依赖包含React/ReactDOM的MIT和Lucide的ISC许可正文；上游Blueprint/starter-kit未打入当前验证包。

## 限制

可证明本机打包应用能启动，不能证明干净系统安装、跨Mac版本、Windows、签名/公证、升级/卸载、受管生成应用工具链。未配置分发签名或公证（packager可能有运行所需本地ad-hoc签名，不是开发者分发签名）。早期打包脚本默认导入packager报错，修为官方命名导出后成功；无失败产物冒充成功。

判定：内部打包可行性部分通过，S0-02整体待验证；S5正式分发未开始。
