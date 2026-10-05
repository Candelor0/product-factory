# 0.15.0仓库准备检查

2026-10-05，Codex与recovery_audit。用户授权新建私有仓库，保留数字版本标注。本项是工程版本管理，不改变产品任务完成状态。

- 当前Git分支main，账号Candelor0；仓库目标product-factory。
- 工程186文件全部保留，包括测试fixture、模板资源、依赖锁及第三方许可。
- 忽略本地依赖、构建与测试运行数据、上游副本、个人资料、参考截图、原始证据附件；文档摘要与源码哈希保留。
- 有限文本模式扫描未确认真实凭据，命中均为合成测试输入。无单个入库文件超过5 MiB，无符号链接。
- 版本称谓/帮助文本调整后format:check和build通过，后者包含typecheck；日志留在本地artifacts/github-upload。
- 本轮未重新运行产品测试、未调用模型、未构建新的应用安装包。历史验证依据保留，不用上传替代验收。

[本轮工程哈希](source-sha256.json)与[相对0.15.0交付的变化](source-changes.json)标识本次源码。三处工程变化为package描述、打包元数据及设置页帮助文案，未重新声明历史运行验证对应此次文案更新。

首次提交4f6c471fa6a43d2f45e7fb8e504c1ff619f9ef73已推送到[Candelor0/product-factory](https://github.com/Candelor0/product-factory)并与远端main核对一致。GitHub返回isPrivate=true、defaultBranch=main、description=0.15.0；291文件、3,127,457字节，敏感模式扫描只命中已审阅的合成私钥头拒绝测试。后续提交仅补仓库交接记录；最终Git标签为0.15.0，不上传安装包或创建Release。
