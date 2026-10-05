# 受控构建与前端预览

日期：2026-10-04（补D-030）。D-026对应S3-01、S3-02与S4-01的局部实现，不能代替完整阶段验收。

## 从源码到页面

当前开发计划中的源码草稿，以`src/app.tsx`默认导出的React组件作为入口。点击「构建并预览」后，主进程校验已确认计划、源码版本与哈希；随包esbuild将虚拟源码编译为内存中的JS/CSS，成功产物原子保存后，才在独立窗口载入。这个操作不调用模型。

编译器不运行生成的脚本、配置或包安装命令，不把模型源码加载到Node。支持同一虚拟树中的相对模块和CSS，以及固定的React、React DOM client、JSX运行时与`@factory/data`数据SDK。第三方依赖、Node模块、远程模块、CSS外部资源、非字面量动态导入和require被拒绝。先做不解析依赖的TS/JSX转换，再用Acorn检查AST，避免esbuild动态glob在检查前扫描宿主目录。

开发构建固定esbuild 0.28.2及React 19.3.0运行时，保存清单SHA-256。桌面版校验运行时及本机二进制，再设置绝对`ESBUILD_BINARY_PATH`，最后惰性加载esbuild JS。Mac包把本机二进制放在`app.asar.unpacked/dist/toolchain/`，用户无需安装Node或npm。该校验依赖完整应用包；不是抵御同一用户任意修改整个包的系统安全边界。

## 版本、取消与保存

构建请求只含schemaVersion、requestId、projectId、planRunId、sourceRevision。编译前后重新核验计划和源码；取消、30秒超时或版本变化时，不采用迟到产物。已有成功请求可去重，标识与内容冲突则拒绝。

成功产物位于`projects/<id>/runs/builds.json`，schema 1，关联源版本、完整源码哈希、确认计划输入/产物哈希、工具链版本和JS/CSS哈希。最多20份、记录32MiB、单次产物8MiB；达到限制会明确失败，不自动删除历史。存储使用临时文件、fsync、重查和rename，并拒绝损坏、未来格式、符号/硬链接及已观察到的文件消失。此为受信单写者协议，未声称任意恶意本地并发安全。

编译失败保留旧产物，显示受限文件/行诊断，不回显宿主路径或原始内部异常。普通单次构建的失败诊断仍仅在本次界面保存；0.8.0另提供[D-027有限修复](BOUNDED_REPAIR.md)，修复运行的固定诊断与状态会持久化。相同仍有效计划下可显式打开旧源码产物的临时预览；持久应用新打开必须匹配当前源码。确认方向变化后旧产物不得重新打开。编译成功不修改计划任务或业务验收状态。

## 预览边界

每个预览使用独立非持久session、sandbox renderer、contextIsolation、关闭Node且无preload桥接。固定自定义协议提供当前候选静态资源、data.js与唯一POST /app-data路由，不提供文件或任意HTTP路由；拒绝导航、子框架、弹窗、下载和设备权限。CSP sandbox含allow-scripts/allow-forms、不含allow-same-origin，因此页面为opaque origin；form-action none仍阻止原生外部提交。connect-src只允许本窗口协议origin，数据路由进一步核验主框架/请求方法/一次性内部许可与容量。临时预览数据关闭即丢失；显式本地应用使用独立持久会话，均没有工作台凭据或任意文件接口，见[数据协议](PERSISTENT_APP_DATA.md)。

网络限制由多层共同完成：请求白名单、CSP、专用SOCKS拒绝代理、WebRTC `disable_non_proxied_udp`及本Electron进程启动时的Chromium域名解析限制。代理持有随机回环端口并销毁连接，没有DIRECT回退；预览关闭释放窗口、协议与监听端口。工作台模型请求走主进程Node网络栈，固定博客样例使用字面量回环地址。

选择以上组合的原因是本机实际负例证明：单独CSP、session离线或WebRTC策略不足以拦住所有STUN/TURN路径。具体实测组合、正负对照及适用版本以[本轮证据](evidence/2026-10-03/S3-01/controlled-build/result.md)为准，不推断其他OS、Chromium版本或所有可能旁路均已验证。

## 后续工作

已有有限启动反馈/修复、源码检查点与限额JSON持久服务。源码导出、数据结构迁移/图片、完整Blueprint分析与业务验收尚需开发。当前仍限于受控生成前端，未开放任意生成后端，也未完成个人博客全链路。
