# 仓库说明

版本：0.19.0。源码、版本标签和Mac Release附件已上传，仓库已按D-040公开；实际执行结果见[本轮记录](sessions/2026-10-05-13.md)。当前按D-037优先Mac版与核心功能，Windows发布延后。

GitHub：[Candelor0/product-factory](https://github.com/Candelor0/product-factory)。公开仓库，默认分支main。源码提交b8ac49bc1118f45f55fac5e34b7c72f561ebdaf7对应标签0.19.0；后续交接文档随main维护。

## 保存范围

仓库保存产品工厂源码、测试、构建脚本、依赖锁、第三方许可、需求/设计/任务文档，以及验证报告摘要和源码哈希清单。

以下内容留在本地，不通过Git上传：依赖与编译目录、打包输入、测试运行数据、上游参考仓库副本、个人项目经历资料、设计参考截图、原始运行日志和证据截图。验证摘要中的本地附件链接可能不在远端仓库内；这不表示附件曾被上传。真实应用数据和模型凭据使用系统应用数据目录，不能加入仓库。Mac应用包作为独立Release附件上传，不进入Git历史。

## Mac下载

[0.19.0 Release](https://github.com/Candelor0/product-factory/releases/tag/0.19.0)提供Apple Silicon Mac ZIP、SHA256校验值和使用说明。AI功能需用户自己的模型Key。当前没有Windows或Intel Mac包；未完成Apple分发签名、公证、其他Mac干净安装及完整真实模型业务验收。

## 从源码运行

在已准备Node/npm的开发环境中执行：

```sh
cd engineering/desktop
npm ci
npm run build
npm start
```

依赖版本以package-lock.json为准。Mac打包命令为`npm run package:mac`，构建产物写入根目录的artifacts。测试与平台验证范围见[开发说明](DEVELOPER_GUIDE.md)和[验收文档](ACCEPTANCE.md)。

## 版本与接续

Git标签使用版本号。实际功能、未完成事项和验证结果继续以[TASKS](TASKS.md)为准，版本称谓不改变验收结论。后续修改遵循根目录AGENTS.md，文档、工程和构建产物保持分目录。
