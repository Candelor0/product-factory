# 生成应用的持久业务数据协议

日期：2026-10-05。对应 D-030/D-033/D-034、S3-01、S4-01 及 S4-02 的业务数据分离、备份与有限结构迁移子项。本文描述当前源码实现；任务状态和最终验证结论以 [TASKS.md](TASKS.md) 及关联证据为准。

## 范围与入口

生成应用通过受控模块 `@factory/data` 读写项目业务 JSON，例如文章、清单和偏好。编译器把该模块解析为受信任的浏览器 SDK，生成源码不能指定宿主路径、项目 ID、数据库文件或任意后端接口。原博客样例的数据接口与目录保持独立。

普通预览、隐藏启动检查和自动修复中的检查使用临时数据。用户主动点击「打开本地应用」后，先在临时会话中检查启动；通过后销毁检查窗口，再创建具有新 origin、新 renderer 和新数据会话的本地应用。临时会话不会升级成持久会话，其数据也不会导入真实项目。

本地应用只能从当前源码对应且仍符合确认方向的构建打开。已经打开同一构建时只聚焦原窗口。真实应用开始运行后可以提交业务数据；即使随后启动观察或交互报错，已经提交的数据也不会自动回滚。启动检查通过仅代表有限观察未发现错误，不保证完整业务正确性。

## SDK 与请求格式

```ts
import { appData } from '@factory/data';

const snapshot = await appData.read();
// { revision: 0, values: {} }

// 一次用户保存对应一个固定请求；不确定时保留整个请求。
const pendingSave = {
  requestId: crypto.randomUUID(),
  expectedRevision: snapshot.revision,
  changes: [
    { operation: 'put', key: 'posts', value: [{ title: '第一篇文章' }] },
  ],
};
const result = await appData.apply(pendingSave);
// { revision: 1, appliedRevision: 1, replayed: false }
```

SDK 只有两个异步方法：

| 方法 | 参数 | 成功结果 |
| --- | --- | --- |
| `appData.read()` | 无 | `{ revision, values }`，完整业务快照 |
| `appData.apply(request)` | `{ requestId, expectedRevision, changes }` | `{ revision, appliedRevision, replayed }` |

`put` 创建或整体替换一个顶层 key 的值，不是局部合并。`remove` 删除一个已存在的 key；删除不存在的 key 返回 `APP_DATA_CONFLICT`。一次请求内 key 不能重复，全部变更一起生效或一起拒绝。成功的新事务使整体版本加一，即使 `put` 的内容与原值相同；没有按 key 独立递增的版本。

SDK 使用当前会话 origin 下的 `POST /app-data`，`Content-Type: application/json`，不携带凭据。传输格式为：

```ts
// 读取
{ schemaVersion: 1, operation: 'read' }

// 写入
{ schemaVersion: 1, operation: 'apply', requestId, expectedRevision, changes }

// 响应
{ ok: true, value: snapshotOrApplyResult }
{ ok: false, error: { code, message } }
```

协议拒绝未知字段、缺失字段和未知 schema。生成应用不能通过 payload 切换项目、会话模式或访问范围。SDK 将失败转为带 `.code` 的 `Error`，不自动重试；服务端错误只返回固定类别和安全提示，不包含原始异常、宿主路径或凭据。

## 版本比较与请求去重

`expectedRevision` 是调用方读到的整个数据快照版本。新请求只有在它等于当前版本时才提交，否则返回 `APP_DATA_CONFLICT`。应用应保留用户编辑，重新读取后展示或合并冲突；不能在后台悄悄覆盖较新的内容。

`requestId` 必须为规范的小写 UUID v4。最近 256 次成功提交各保存一个回执，记录规范化请求的 SHA-256、原版本和实际提交版本。对象字段按键排序，数组和变更顺序保留；因此仅 JSON 对象字段顺序不同视为同一请求，变更顺序不同则不是。

存储先查回执，再检查版本：

1. 保留期内同一 ID、同一完整请求返回原回执，不再次写入；即使 `expectedRevision` 已旧，仍可确认原操作。
2. 同一 ID 对应不同参数，返回 `APP_DATA_REQUEST_CONFLICT`。
3. 没有回执时执行版本比较。原请求的回执即使已淘汰，其旧 `expectedRevision` 仍会触发冲突，不会重复应用。

响应中的 `revision` 是核对时的当前版本，`appliedRevision` 是这次操作最初提交的版本，`replayed` 表示是否命中已有回执。例如版本 3 的保存请求在项目已到版本 8 后重试，返回 `{ revision: 8, appliedRevision: 3, replayed: true }`。这不表示版本 8 的业务内容仍等于版本 3。

去重窗口有界，不承诺永久记住所有 ID。回执淘汰后，如果调用方擅自把旧 ID 改为当前版本及新参数，存储无法识别它曾被使用。新的用户操作应使用新 ID；核对一次不确定操作时，应保留原 ID、原版本和原内容，不修改请求、不改用新 ID 重发。

## JSON 与容量限制

所有字节限制按 UTF-8 序列化 JSON 计算，KiB 为 1024 字节，MiB 为 1024 KiB。

| 项目 | 当前限制 |
| --- | --- |
| 顶层 key | 小写模式 `[a-z][a-z0-9_-]{0,63}`；最多 128 个 |
| 单次写入 | 1—32 个 `put` / `remove`，key 不重复 |
| 单个顶层值 | 最多 128 KiB |
| 整体快照 `{ revision, values }` | 最多 1 MiB |
| 写入请求 / 传输请求体 | 最多 1 MiB + 64 KiB |
| 单值嵌套深度 | 最多 16 层，顶层业务值从第 1 层计 |
| 校验节点 | 单次快照或请求校验最多 20,000 个，按该次校验累计 |
| 版本 | 非负安全整数；达到上限后拒绝递增 |
| 历史快照 | 当前快照以外，保留最近 5 份完整快照 |
| 请求回执 | 最近 256 次成功提交 |
| 持久记录 `state.json` | 当前快照、历史、回执、结构与最新迁移前检查点合计最多 8 MiB |

值只支持 `null`、布尔、有限数字、字符串、数组和普通 JSON 对象。拒绝非有限数字、`undefined`、函数、BigInt、Symbol、循环引用、稀疏数组、访问器及非普通对象；对象的 `__proto__`、`prototype`、`constructor` 字段在任意层级均被拒绝。嵌套业务对象的其他字段名不受顶层 key 正则限制。负零规范化为零。

SDK 先做 JSON 序列化，主进程严格校验收到的 JSON。直接调用受信任纯函数时也检查对象描述符和原型，不读取 getter。业务应用应主动使用普通 JSON，不能把 JavaScript 类实例的行为当作持久协议的一部分。

8 MiB 是单个已提交记录的上限，不是整个磁盘目录的配额。写入期间存在临时副本，进程异常终止还可能留下临时文件；这些文件不会自动成为正式数据，也不能算作已提交历史。

## 目录与记录格式

实际位置在工作台应用数据根目录下，独立于工程源码和构建产物：

```text
projects/<projectId>/
  data/
    blog/                         原博客样例数据，互不覆盖
    generated.initialized.json    外层初始化标识
    generated/
      identity.json               内层身份记录
      state.json                  当前快照、5 份历史、256 个回执；schema 2 另含结构与迁移检查点
```

两个身份记录包含 `schemaVersion: 1`、`projectId`、随机 `storeId` 和初始化时间。它们必须一致，业务记录也必须属于同一项目和 `storeId`，防止误接其他项目或另一份初始化的数据。

旧 `state.json` schema 1 包含 `current`、`history` 和 `receipts`，继续按无结构声明的数据读取，不因查看状态而改写。0.15.0首次显式结构迁移或带结构的新库初始化使用 schema 2，另有 `schema`、`schemaHash` 与可空的 `migration` 检查点。每份完整快照携带 SHA-256，历史版本连续，回执版本连续且 ID 唯一。数据 revision 0 必须为空。读取会检查字段、身份、容量、哈希和版本关系，不能只因 JSON 可解析就视为有效。

最近 5 份历史与当前数据在同一个文件中一起提交。这是有限恢复材料，不是独立备份、无限日志或数据回滚功能；没有向生成应用开放历史读取或回滚接口。0.14.0增加工作台主动选择备份文件、预览影响并确认的恢复入口；恢复追加新版本，不直接选择或回退这些历史。见[数据备份与恢复](DATA_BACKUP.md)。哈希用于一致性校验，不是针对能够任意改写本机文件的攻击者的认证签名。

## 原子初始化与中断恢复

受信任存储的首次读取或写入可初始化数据；持久应用会话可触发这一初始化路径；0.14.0新增的备份状态/导出/恢复使用不初始化、不补齐标记的独立读取，临时预览也不会触发磁盘初始化。只有 `generated/` 与外层标识同时不存在，且项目及其祖先目录有效、项目未归档时，才视为首次初始化。

初始化先在 `data/.generated-init-<UUID>.tmp/` 写入完整身份和版本 0 空数据，逐文件 `fsync`，再同步暂存目录。随后重新检查项目状态及目标不存在，将整个暂存目录原子 rename 为 `generated/`，同步父目录，最后通过临时文件与 rename 写入外层标识。

中断后的处理以实际文件为准：

| 磁盘状态 | 行为 |
| --- | --- |
| 两个正式位置都不存在 | 可重新初始化；遗留暂存目录不会自动提升为正式数据 |
| `generated/` 的身份与数据完整有效，外层标识尚未写入 | 校验完整记录后补齐外层标识，不改写业务数据 |
| 外层标识存在，但 `generated/` 消失 | 拒绝读写，不重新生成空数据 |
| `generated/` 存在，但身份或 `state.json` 缺失 | 拒绝读写，不用空值或历史替代 |
| 内外身份不匹配、内容损坏或格式不支持 | 拒绝读写并保留现场 |

目录 rename 后初始化结果仍无法确认时，返回 `APP_DATA_INITIALIZATION_UNCERTAIN`；后续显式读取依据上述规则核对。初始化标识的作用包括让新的进程发现已初始化数据目录被删除，不能仅依赖当前进程的内存记忆。

如果外部同时删除全部业务数据与外层标识，并重建了必要目录，新进程无法区分它与真正的首次使用。整个 `data/` 的丢失可能先被项目目录校验拦截，但这不等于拥有独立于该目录的删除证明。当前实现不承诺识别整体删除、自动找回数据或抵御拥有本机文件写权限的任意破坏。

## 原子写入与不确定结果

一次提交先在内存中完成严格校验、回执检查、版本比较及完整快照计算，再把新当前快照、滚动历史和回执写入同目录独占临时文件。写完 `fsync` 并关闭后，重新检查项目未归档、存储身份未变和旧记录字节哈希未变，最后用 rename 替换 `state.json` 并同步目录。

rename 之前失败，原数据仍是正式版本。rename 之后发生异常，存储只在严格重新读取且完整字节哈希与拟提交记录一致时确认成功，不执行第二次写入。无法精确确认时返回 `APP_DATA_COMMIT_UNCERTAIN`，应用必须保留编辑与原请求，允许用户核对结果。

正常失败只清理本次创建的临时文件；崩溃遗留的合法临时文件保留且不会自动提交。目录中出现未知文件、链接、硬链接、非普通文件或异常目录会拒绝访问；路径与祖先目录也受项目存储校验。持久层使用同步受信任写入，当前工作台按单主进程运行，不提供多独立写入进程的分布式事务保证。

当前代码在非 Windows 平台执行目录 `fsync`，Windows 跳过目录同步。具体平台的断电持久性和文件系统行为不能仅凭该实现描述视为已经验收。

## 可选结构与显式迁移

0.15.0允许源码提供 `src/data-schema.json`。无声明对应结构版本 0，持久定义为 `null`；声明的 `version` 是业务结构版本，与磁盘格式 `schemaVersion`、业务快照 `revision` 分开。结构版本范围为 1–1000，定义 `{ version, keys }` 最多 64 KiB、256 个类型节点、8 层深度。顶层声明的键均可省略，但禁止未声明的键；类型支持 string、number、boolean、null、array 及封闭 object，object 可指定 required 字段。它不是任意 JSON Schema 或业务规则引擎。

结构由受信任会话依据构建来源解析，生成应用的 SDK 请求不能自行指定或绕过。`get(projectId, expectedSchema)`、`apply(projectId, request, expectedSchema)` 缺省结构为 `null`；已有存储只有在规范结构哈希相等时才允许读写，同版本改变 keys 也不相等。新库可直接以来源结构初始化为空对象；旧库不能借首次打开新源码隐式改变结构。每次业务提交还校验完整目标 values，未声明字段或类型不符会拒绝整次写入。

`inspect()` 提供受信任协调层的只读数据和结构，不受来源结构匹配限制，也不初始化存储。旧 schema 1 可不含新增 inspection 字段；schema 2返回当前结构及最新迁移摘要。摘要中的 `beforeSnapshot` 只供主进程计算回退影响，不通过工作台状态接口交付业务值。

迁移声明仅描述相邻版本的有限 `renameKey`、`addKey`、`renameField`、`addField` 操作，不运行 SQL、JavaScript 或宿主命令。主进程在内存计算目标值，展示键名和变化数量，用户确认后关闭所属持久应用并再次核对源码、数据和项目状态，才调用存储。预览只计算，不改业务文件；完成后不自动重开应用。

持久 `migrate()` 请求包含固定请求 ID、storeId、当前 revision/快照哈希、`fromSchemaHash`、目标 schema 和完整 values。目标必须是当前结构 n 的 n+1，且非 null；无结构旧库只能迁到结构 1。校验目标值后，一次原子提交以下内容：

- 当前 values 和数据 revision + 1。
- 新结构定义及结构哈希。
- 恢复前快照进入原有 5 份历史，新增回执进入原有 256 条窗口。
- 一个最新迁移前检查点，保存原快照/结构、目标结构、原迁移请求 ID、迁移提交 revision 和整体 SHA-256。

首次从磁盘 schema 1 转成 2 保留原 history、receipts 和存储身份，不生成另一份空库。检查点与当前数据在同一个 `state.json` 内发布，不能出现仅结构或仅数据迁移完成的正式状态。检查点中的原快照、前后结构、版本关系、请求回执及仍在历史中的同版本快照均要核对；检查点计入原 8 MiB 总上限，容量不足拒绝写入。

`rollbackMigration()` 仅允许回退最新一次迁移，且当前数据 revision 必须仍等于该迁移的提交 revision。一旦随后发生业务 apply、备份 restore 或其他数据提交，即使值相同也不能回退。工作台还要求当前源码声明等于迁移前结构，避免把数据回退给不兼容的新代码。

回退恢复检查点的原 values 和原结构，同时再追加一个新的数据 revision、历史及回执，并将该检查点标记为不可再次回退。回退到无声明的 `null` 结构也保持磁盘 schema 2；需要继续使用0.15.0或更新版，不能把它交给只支持 schema 1 的旧程序。后续新的迁移会替换最新迁移检查点，不建立无限迁移链。

迁移和回退的回执带各自操作前缀，不能与普通 apply 或备份 restore 的同 ID 混用。同 ID、同完整请求优先核对已提交回执，不再写入；版本或结构已改变而原请求未提交则拒绝。记录仍只保留最近256条，淘汰后原请求的旧 revision 也不能再次应用。取消、错误或中断不会自动重放迁移；发布后回复不确定时仍按原请求核对，不生成新的迁移 ID。

普通备份 restore 增加可选 schema（缺省 null），只接受与当前存储完全相同的结构，不能借备份改结构；即使命中旧恢复回执也须满足当前结构匹配。源码检查点回退同样不代替数据迁移回退。本能力不包括跳过多个版本、类型强制转换、任意删除/脚本、损坏存储重建或自动判断业务兼容性。

## 临时与持久会话

| 行为 | 临时会话 | 持久会话 |
| --- | --- | --- |
| 使用入口 | 页面预览、隐藏检查、自动修复检查 | 用户显式打开本地应用 |
| 初始数据 | 每个新会话都是版本 0 空对象 | 项目已有快照；未初始化时创建空存储 |
| 写入位置 | 主进程内存 | 项目 `data/generated/` |
| 版本与校验 | 相同 JSON、容量、CAS 规则 | 相同规则，另做文件安全和身份校验 |
| 去重 | 会话内最近 256 个回执 | 磁盘最近 256 个回执，重启后仍可核对 |
| 历史 | 无持久历史 | 最近 5 份完整快照 |
| 关闭或撤销 | 清空数据与回执 | 撤销访问能力，已提交数据保留 |
| 再次启动 | 新会话重新为空 | 用户再次打开后读取已有项目数据 |

会话身份由受信任窗口工厂根据构建产物建立。持久会话在每次读取和提交前重新核对项目、确认计划、计划输入哈希及计划产物哈希；归档、确认失效或计划变化会拒绝旧会话请求。存储内部允许受信任代码读取归档项目的既有完整数据，但不允许初始化或写入；生成应用不能绕过会话层直接使用这个读取入口。

业务数据属于项目，不绑定某一个源码 revision。源码检查点恢复、重新生成、编译或修复不会回退、清空或迁移 `data/generated/`。存在结构声明时，旧代码重新打开仍须与当前数据结构匹配；不匹配必须先完成用户明确确认的有限迁移或满足条件的迁移回退。类型校验不等于完整业务兼容性判定。

## 会话通道与撤销

每个窗口使用随机 `factory-preview://<token>` origin 和独立非持久 Electron session。SDK 请求被限定在该窗口主 frame 的精确 `/app-data` 地址，由受信任网络拦截器核对 webContents、进程和 frame，再附加一次性请求许可。这个许可与业务去重用的 `requestId` 不同，生成页面不能通过伪造一个请求头替代发送者校验。接口没有把 CORS 响应头当作授权依据。

通道只接受规定的 `POST` 与预检请求；请求体有字节限制，读取截止为 5 秒，每个窗口每分钟最多 180 次数据 POST、最多 4 个并发请求。限流返回 `APP_DATA_RATE_LIMIT`。超限、格式异常或请求许可不足可在进入业务存储前被拒绝，SDK 仍不自动重试。

关闭、取消、替换或渲染进程退出会撤销会话。请求体读取是异步的，因此读取完毕还要再次检查撤销状态；不能让关闭前尚未收完的请求在关闭后提交。候选失败时保留旧窗口，成功替换时撤销旧会话。撤销不会撤销已经完成的事务。

生成 renderer 没有 Node、preload 或工作台桥接；沿用固定静态资源、CSP、权限/导航/下载拦截和网络隔离策略。模型只获得 SDK 使用协议，不通过该接口读取用户业务数据。这里的受控 JSON 能力不是任意业务后端、数据库、文件系统 API，也不是完整系统沙箱。

## 错误处理与验证范围

| 错误类别 | 调用方处理 |
| --- | --- |
| `APP_DATA_CONFLICT` | 保留编辑，重新读取并处理版本冲突 |
| `APP_DATA_REQUEST_CONFLICT` | 核对请求身份；不能复用同一 ID 保存不同内容 |
| `APP_DATA_COMMIT_UNCERTAIN`、`APP_DATA_INITIALIZATION_UNCERTAIN` | 保留现场并核对；保存核对沿用原完整请求 |
| `APP_DATA_NETWORK`、`APP_DATA_RESPONSE` | SDK 无法确认结果，不能直接声称未保存 |
| `APP_DATA_INVALID_INPUT`、`APP_DATA_INVALID`、`APP_DATA_LIMIT` | 检查 JSON、请求格式或容量，保留编辑 |
| `APP_DATA_SCHEMA_MISMATCH`、`DATA_SCHEMA_MISMATCH` | 核对来源声明与当前结构，或修正不符合结构的数据；不自动迁移 |
| `APP_DATA_MIGRATION_CONFLICT`、`DATA_SCHEMA_MIGRATION_CONFLICT` | 核对相邻结构版本、名称冲突和迁移后写入；原数据保留 |
| `DATA_SCHEMA_INVALID`、`DATA_SCHEMA_LIMIT` | 修正结构声明格式或容量，不执行生成脚本 |
| `APP_DATA_MISSING`、`APP_DATA_CORRUPT`、`APP_DATA_UNSUPPORTED`、`UNSAFE_PATH` | 停止操作并保留文件，检查有效备份；不初始化覆盖 |
| `APP_DATA_REVOKED`、`ARCHIVED`、`STALE_PLAN`、`CONFIRMATION_REQUIRED` | 检查项目状态并重新打开获准的应用 |
| `APP_DATA_RATE_LIMIT`、`APP_DATA_FORBIDDEN`、`APP_DATA_UNAVAILABLE`、`APP_DATA_IO` | 展示固定提示，保留编辑并检查当前会话或存储状态 |

实现和测试入口：

- [共享契约](../engineering/desktop/src/shared/app-data-contracts.ts)、[JSON 校验与纯应用函数](../engineering/desktop/src/main/app-data-protocol.ts)、[持久存储](../engineering/desktop/src/main/app-data-store.ts)。
- [会话服务](../engineering/desktop/src/main/app-data-service.ts)、[浏览器 SDK](../engineering/desktop/src/main/app-data-sdk.ts)、[窗口与通道](../engineering/desktop/src/main/generated-preview.ts)、[受控编译器](../engineering/desktop/src/main/source-compiler.ts)。
- [协议单测](../engineering/desktop/tests/app-data-protocol.test.ts)、[存储及四个真实子进程 SIGKILL 边界测试](../engineering/desktop/tests/app-data-store.test.ts)、[会话单测](../engineering/desktop/tests/app-data-service.test.ts)、[SDK 单测](../engineering/desktop/tests/app-data-sdk.test.ts)。
- [结构协议](../engineering/desktop/src/main/data-schema-protocol.ts)、[结构迁移协调层](../engineering/desktop/src/main/data-migration-service.ts)、[存储结构及迁移中断测试](../engineering/desktop/tests/app-data-schema-store.test.ts)。
- [Electron 通道边界测试](../engineering/desktop/scripts/app-data-preview-electron.ts)、[应用端到端与跨进程重开测试](../engineering/desktop/tests/app-data-electron-smoke.ts)。测试文件的存在不代表对应运行已经通过。

本文说明实现协议，不单独宣布验收通过。局部协议、存储及 Electron 通道检查不能替代完整产品验收；端到端执行结果与范围以任务台账中的实际证据为准。0.14.0另提供生成应用数据单独外部备份与同项目/storeId/同源码内容的显式恢复，0.15.0增加上述有限JSON结构迁移，实际证据见TASKS。仍不承诺损坏或整体丢失存储的重建、跨项目导入、通用数据库迁移、图片附件、任意后端、完整业务验收、双平台断电测试或完整系统沙箱。
