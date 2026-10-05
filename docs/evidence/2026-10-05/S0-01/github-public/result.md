# 0.19.0 GitHub上传与公开检查

日期2026-10-05，执行者Codex及public_upload_audit/release_archive。用户授权先上传当前版本，再公开Candelor0/product-factory；版本标题和仓库说明仅标0.19.0。产品阶段状态不因上传而变更。

## 源码与历史检查

初次工作区候选341文件、3,826,742字节；213工程文件全部与[0.19.0受测哈希](../../S3-02/core-flow/source-sha256.json)一致且均待入库。最终入库集合包含随后新增的本轮交接文档，数量在提交时核对。main及0.15.0标签可达历史为2提交、296个blob、3,189,494字节。无超过5MiB文件、二进制、源码符号链接或真实日志/数据目录；凭据模式匹配均核实为合成拒绝测试，未发现确认的真实凭据或私人业务数据。有限扫描不保证识别任意秘密。

历史项目经历会话只有文档制作流程，没有简历正文、姓名、雇主或联系方式；Word与截图保持忽略。只推送main及0.19.0标签，不推送Codex本地快照refs，不改写已有历史。安全元数据扫描留在本地artifacts/github-public-019，不上传原始匹配内容。

## Mac附件

已有应用原样归档，不重新编译、签名、启动或读取用户数据。ZIP为`product-factory-0.19.0-macos-arm64.zip`，134,883,008字节（128.63MiB），SHA256 `66caef9ea97d59727553a12e6569ac1e61b1bdf01aeb7484d847e5cc598e6f38`。

独立临时目录解压后，262文件SHA256、14符号链接目标、314目录及执行权限与原包匹配；应用及Electron/Chromium许可、运行时版本文件、中文使用说明保留。ASAR仍为`081d48f0024e4d93e340742cd9eb94cb56c70724c345c1f4ffc14ef839f8423d`。详细逐文件结果为本地[归档记录](archive-verification.json)。

附件明确仅Apple Silicon Mac，AI需自备Key；无Apple分发签名/公证、其他Mac干净安装或完整真实模型业务验收结论，不含Windows/Intel Mac包。不要求关闭系统保护。

## 发布执行

开始前GitHub实际返回private、ADMIN权限、main为fd80130752d9885c3c413f2231c86c378eac2416、无Release、Actions运行数0。提交/推送、附件上传与public变更尚待本轮真实操作，结果完成后在此及会话13补记。无本轮产品测试、真实模型调用或新工程改动。
