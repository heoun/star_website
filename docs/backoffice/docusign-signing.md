# Rental lease 自动签发：DocuSign 接入

状态：2026-09-16 流程已获 Ocean 确认，代码及隔离测试已实现。
尚未应用真实数据库迁移、配置真实账号、部署或发送真实合同；sandbox 全链路签署待联调。
契约在 `backend/contracts/rental-signing.ts`；现有 `/api/v2` 的 fake 签署接口保持独立。

## 已确认的需求

- 使用项目现有 lease Word 模板自动生成合同，不迁移到 DocuSign 模板。
- 用户已有 DocuSign 账号、Integration Key 和接入经验。
- Agent/Admin 从 Rental 的 application 查看资料并发起签署。
- 使用现有房东同意流程：application group 完整 → 房东同意 → 准备合同 → staff 审阅并发送。
- 所有 tenant 先签，全部完成后由 landlord 签；签署进度、最终合同自动回写。

这里的自动化包含生成、发送后的状态同步和归档。第一版仍由 staff 点击发送，
房东批准 application 不会直接触发签署邮件。

## 界面与权限

入口：`Rentals → application group → Lease & Decision`。

1. 点击 **Review Signing Package** 准备签署包，显示收件人及 **Review Lease Draft**。
2. **Review Lease Draft** 打开左侧待签合同、右侧条款核对。平台读取该包保存的原始 DOCX，校验 SHA-256 后渲染，无需下载。审核状态只保存在当前页面会话中，并绑定 rental revision；修改条款会清除该状态。
3. 审核界面可直接 **Send With DocuSign**。也可在 **Lease & Decision** 发送；未打开本次签署包审核时，必须再次确认跳过审核，弹窗列出收件人。后端仍验证版本、批准记录、签署人及幂等性。
   审核页的 **E-sign Recipients** 只显示一份签字顺序和收件人列表；发送统一位于底部。尚未打开待签版本时，底部另提供 **Review Signing Package**，打开成功后隐藏这个入口。直接点击发送会先准备签署包，再按审核状态决定是否显示确认框。
4. 每个人分别显示等待、已送达、已签署、拒签；landlord 明确显示等待 tenants 签完。
   面板顶部是六段进度条 Prepared / Uploaded / Sent / Tenants Sign / Landlord Signs / Completed，
   当前段有流动动画，needs_attention 时当前段变琥珀色；条下一句说明当前步骤：上传中显示
   文件数（服务端投影 `uploading`，即 creationAttemptedAt 已记录），租客签署中显示已签人数。
   两个入口（Lease & Decision 和审核页 E-sign Recipients）共用同一段 markup。
5. 全部签完且文件归档成功后显示 **Completed**，提供签署 PDF 与完成证书下载。

Admin 对应当前代码里的 `manager`。Agent 必须是该申请组负责人或 collaborator；
仅有物业权限不够。沿用现有 owner 只管理权限的限制。Landlord/tenant 不能调用发送接口。
未配置 DocuSign 时显示未连接，不伪装为已发送。

tenant 收件人来自各成员的独立 application，不能拆分 `householdApplication.email` 拼接字符串。
landlord 邮箱来自当前已批准的 recommendation，并核对物业有效签署人；
签署姓名使用冻结合同的 `landlord.print_name`。收件人缺失、重复或与批准版本不一致时阻止发送。
staff 不能在发送请求中任意覆盖邮箱。需要更正时返回原资料流程，并重新审核受影响的版本。

## 合同与签名位置

现有模板包含主合同及 14 份 rider/notice；`fillTemplate` 生成一个 Word 文件，
不按条件删除章节。签署包按原有文档边界分别保存 DOCX；保留原始 OOXML 的
正文及资源；签字表格采用经审核的模板布局，不增加日期栏。
每个文件单独绑定签署字段，避免多个 rider 使用相同文字时定位到其他文件。

### 锚点 token（2026-09-19 起）

每个签署字段由唯一的 2 磅白色 token 定位，写入原签字线所在的段落或表格单元格。
DocuSign 在自己的转换 PDF 中解析锚点，正文分页改变时字段随之移动。
空白签字段落同时保留一枚使用原段落字体属性的不可见不换行空格；否则转换器会用
2 磅 token 重新计算行高，使已放字段的下划线向上移动。原边框和正文均保留。
initials / Bedbug 的 token 延续黑色下划线；合并审阅版不含 token。

`site/shared/lease-signing-layout.js` 统一提供预览与发送几何参数。Sandbox 回读确认：
签名和 initials 的锚点参考高度分别固定为 33pt / 38.4pt，并不会随 scaleValue 变化。
因此偏移必须补偿参考高度与实际缩放高度的差值。默认签名为 .75、initials 为 .8；
Print Name 和日期使用 11pt。签名图上的 Signed by 头和 ID 尾保留。
房东签字与租客同尺寸，同样从签字线左端开始；八租客表第二排也是 .75；
签字线上方的净空由模板留出，见下文「签字线上方的间距」。
Window Guards 的签字沿原线内缩 100pt；日期内缩 96pt，补偿 DocuSign 不同字段类型的 4pt 定位差，保持可见左缘对齐。
预览与跨收件人重叠校验均使用可见签字框（包括头尾），排除透明控件底部的空白。
旧 v5–v10 草稿禁止发送，需通过现有取消和审核流程生成 v11；不改变已经发出的信封。

多租客签署包（4 租客 25 份文件）建好草稿后，首次带 include_anchor_tab_locations 回读某位收件人的 tab
要 DocuSign 渲染全部页面，实测超过 30s；adapter 对这一类请求和建草稿一样放宽到 120s，其余仍 30s。
同一草稿第二次回读只要几秒。

Sandbox（demo / 免费）账号每个信封最多 5 个收件人，付费账号 99；超过时 DocuSign 在建草稿时
返回 RECIPIENT_LIMIT_EXCEEDED，adapter 映射为明确提示并停在 needs_attention。所以沙盒里
多租客最多只能测 4 租客 + 房东，八租客表的第二排只能靠本地投影检查。

v8 曾用 Sandbox 的单租客草稿转换 PDF 和回读 tab 核查 59 个字段，均落在原线附近且无字段重叠。
八租客主合同的 34 个字段使用已有供应商转换 PDF 和锚点坐标做本地投影检查；
新尺寸尚未重新上传验证。实际签字风格仍需在签署界面最终核对。

### v9 签字区一致性修正

保持第 47 条原签字表及字段位置，其他同型 rider 的租客和房东表采用该表的
字号、行距、边框及列宽。Sprinkler 的 Tenant 标题独占一行，Signature 不再与标题合并。
这些修改只涉及签字区格式，所有原有文字与占位符保持一致。
Rider Print Name 上移 2.5pt，日期上移 3pt，为下伸字母和日期留出横线上方间隙。
Bedbug 的签字向右内缩 6pt、上移 1pt，日期向右内缩 4pt，以避开标签。
DHCR 双方签字和日期分别在原下划线宽度内居中，日期按 11pt 数字日期的 50pt 控件宽度定位。
本地转换器与 DocuSign 的 Word 排版不完全一致；v9 仍须独立核查供应商转换结果，
不能把 v8 的转换验证结论当作 v9 已验证。

### 签字线上方的间距

在 v9 的 sandbox 转换页上量得：签名块从「Signed by」到 ID 尾高 25pt，压线下 1.5pt，
所以每条签字线上方需要 26.5pt 净空；「Tenant:」到租客签字线只有 14pt，
「Landlord or Landlord’s Representative:」到房东签字线 12.8pt，八租客表第一排
Print Name 线到第二排签字线 18.9pt。`lease/tools/space-signature-tables.py` 做三处修正：
12 张租客表的标题行从 265 twips 加高到 600，第一排 Print Name 行从 320 加高到 560，
12 个房东标题段落加 360 twips 段后距。三处的净空都约 4pt。

于是 v11 起所有租客位和房东位共用一套几何：签名 .75、从签字线左端开始，Print Name
一律比线高 1.5pt，第 47 条与 rider 一致；不再有房东内缩到右半段、第二排缩小之类的
按位置例外。v10 只加高了标题行和房东标题段后距，第 47 条 Print Name 和第二排仍按
旧位；v11 补上第一排 Print Name 行并统一。模板 hash 随之重钉。

v11 已在 sandbox 用 4 租客 + 房东（25 份文件、171 个字段）核查：回读的 tab 位置与 DocuSign
自己转换 PDF 里的 token 位置相差不超过 2.7pt（签名横向一律偏左约 2pt，姓名日期偏右约 2pt，
属于供应商固定取整）；第 47 条与各 rider 的四个租客签名同线同尺寸，房东签名与租客左对齐，
标题到签章净空 5–6pt；§38/§39 initials 逐人落在各自下划线上；Window Guards、Bedbug、DHCR、
Allergen 均在原线上。全员用嵌入式签署签完后的 PDF 外观与上述一致。八租客表的第二排
因 sandbox 收件人上限未能在线核查。

- 主合同：第 38、39 条每位租客一处 Initials（第 i 位租客在第 i 段下划线）；
  第 47 条每位租客一组 Signature / Print Name，两排各四格；房东一组。超过八位
  租客明确报错。
- Utilities、Packages、Keys、Renters Insurance、Community Rules、Fine Schedule、
  Sprinkler、Gas/CO/Smoke Alarm、Smoking、Rent Concession（仅填写实际减免条款时）、
  Good Cause：沿用各自原有的八个租客格和一个房东格。
- Window Guards：租客 Signature / Date Signed 分别放在相应标签下一行的原下划线上。
- Bedbug：租客和房东各 Signature / Date Signed，接在各自标签之后的下划线段起点。
- Indoor Allergen：仅房东 Signature / Print Name / Date Signed。
- DHCR：租客和房东各 Signature / Date Signed，落在各自那一行的两个格子里。

Window Guards、Bedbug、DHCR 原稿只有一组租客签字线，为每位租客生成独立副本，
分别填入该租客资料，token 里带收件人编号，所以整个信封里没有重复的锚点。

E-sign Recipients 的 **Preview Signing Fields** 直接在渲染出来的 token 上画框，
偏移和尺寸与发给 DocuSign 的一致；找不到或找到多个 token 时拒绝预览。

发送前，创建 draft 后用 `include_anchor_tab_locations` 回读每个 tab，核对每个
字段恰好落在自己的文档和页面上，并检查同一收件人在同一页的字段两两不相交；
任一条不满足就不发。平台覆盖层和本地 Word 渲染不能证明 DocuSign 转换后的最终
坐标准确；生产使用前仍须核对 DocuSign sandbox 转换后的 PDF 与字段，并据此
校准 `TAB_GEOMETRY`。

签署包冻结 `lease_snapshot`、approval revision、模板版本、逐人收件人、tabs、
各源 DOCX 及合并审阅版的路径和 SHA-256。发送前展示的合同必须对应同一个 package ID；
合同审阅后有变化，返回 409 要求重新审阅。修改 property defaults 不改变已发合同。
生成或修改 Word 模板时另按 documents 技能渲染检查；DocuSign 转换后的 PDF 和 tabs
还须在 sandbox 实际核对，不能用本地 Word 预览替代。

## 发送与恢复

业务状态继续使用现有 `landlord_approved`、`lease_sent`、`lease_signed`。
新增签署记录保存独立 phase，不将失败、拒签强行映射为租赁申请被拒绝。

| Phase | 意义 |
| --- | --- |
| preparing | 已冻结签署包并持久化发送任务，准备 provider draft |
| sending | 已保存 envelope ID，正在请求 DocuSign 发出签署邀请 |
| in_progress | DocuSign 确认发送，逐人等待签署 |
| archiving | DocuSign 全部完成，正在下载签署 PDF 和 certificate |
| completed | 全部签署及私有归档成功，此时才写入 lease_signed |
| declined / voided | 信封拒签或作废，保留历史和已产生的签署记录 |
| needs_attention | 无法安全自动重试、配置错误或其他需 staff 处理的问题 |

发送顺序：

1. 后端重查权限、整个 group 的资料完整性、房东批准、必填值及逐人邮箱。
2. 生成并私有保存已审阅的源文件；数据库事务核对全部成员版本和批准 revision，
   创建唯一 active package、pending job，并锁定成员/条款/签署人等敏感变更。
3. 使用 package UUID 作为 `transactionId` 创建 DocuSign draft，先持久化 envelope ID。
4. 请求发送同一个 draft；确认 provider 状态后更新 rental 为 `lease_sent`。
5. tenant routing order 为 1，landlord 为 2。

任务通过数据库领取租约和 fencing token 防止并发提交。重试先查已有 envelope 状态，
丢失创建响应时先用 transaction ID 恢复；不能每次重试重新创建合同。
DocuSign 的 transaction ID 查询保留期限为七天；超过期限仍不确定的发送需要人工核查，
不能因查询不到就重发。取消也必须确认 provider 已 void 才允许解除锁或准备下一版。
第一版包含作废操作及原因记录；改约后重新签署必须生成新版本、保留旧信封，并按现有规则重新批准。

所有旧的 application 编辑、成员加入、lease 下载/准备与人工签署记录入口都要检查 active signing lock。
DocuSign 管理的合同禁止通过手工填写 receipt 或上传 PDF 提前标记完成。
历史外部签署记录维持原有查看方式，不能混入新信封的状态来源。

## 回调与归档

新增独立的 `POST /api/webhooks/docusign`。在解析 JSON 前对原始 body 验证 Connect HMAC，
核对配置的 account ID；限制请求体大小。仅验签成功才进入 durable inbox。
回调验签后，只保存 account/envelope、事件时间及规范化后的完整 recipient 状态。
处理任务核对已绑定的信封和全部 recipient IDs，再直接应用此可信快照，不接受回调携带的
文件 URL、rental ID 或任意邮箱。重复、乱序事件不回退签署进度。

事件持久化成功后立即触发后台处理；没有完整快照的事件只提示补偿查询。
直接推送不受 API 轮询预算限制，普通 API 补偿查询仍保持 31 分钟间隔和 16 分钟读取预算。
页面在签署进行中每 5 秒读取本站状态。正常回调网络下的目标是签署后 60 秒内显示状态，
归档下载并行，归档失败 15 秒后重试。DocuSign 自身投递延迟/断网不能承诺绝对时限。

本地完整测试统一使用 `npm run dev:testing`，自动运行专用 webhook 转发、HTTPS tunnel、
Sandbox Connect 订阅、模拟付费/筛查和 15 秒调度。启动时重放未完成测试信封的状态，
无需重新签署或重发邀请；重启自动更新同一个按发送用户限定的 Sandbox Connect 配置。

全部 signer 完成后，通过认证 API 下载 combined signed PDF 与 certificate，写入现有私有
storage。大小、PDF 格式、文件 hash 验证通过后，原子更新每位 tenant receipt、
landlord receipt、signed_lease 及 completed 状态。文件重试使用 package 范围内的稳定路径。
PDF 已下载但数据库写入失败可重试；归档失败显示 archiving/issue，不显示合同已归档。
下载走现有身份和 case scope 验证，不暴露永久公开存储链接。

## 接入位置与数据库

- `backend/core/rental-signing.ts`：发送、恢复、同步、作废用例。
- `backend/adapters/esign-docusign/`：JWT、draft/send、读取状态、验签和下载。
- `backend/adapters/rental-signing-supabase/`：版本事务、唯一信封绑定、durable inbox/jobs。
- `backend/app/rental-signing.ts`：组合根；Worker 只通过 app 层访问后端。
- `worker/rentals.js` / `worker/admin.js`：复用现有租约生成、权限、存储和 staff API。
- `worker/index.js`：接入 webhook 与计划任务。
- `site/admin/rental-group.js`：审阅发送面板、逐人进度和文件入口。
- `supabase/rental-signing.sql`：仅新增 service-only 表和 RPC，RLS 默认关闭客户端访问。

新增 `rental_signing_packages`、`rental_signing_jobs`、`rental_signing_inbox`。
约束包括：每个 rental 最多一个 active package；account/envelope 唯一绑定；
审批和全部成员版本 CAS；签署任务有到期领取锁；事件去重。
预览 package 为一小时内有效的私有预备记录，点击发送时再原子 reserve；
后台每次处理最多清理五个一天前未发送的预备包及其源文件。
文件上传成功但预备包写库失败留下的孤立对象尚无全桶扫描清理，应由存储保留策略处理。
新增接口使用 `/api/admin/cases/:id/signing`：GET 返回已保存包/进度；
POST `action=prepare` 保存审阅包，`action=send` 发起已审阅包；
作废等命令通过受保护的 signing command 处理。GET 不发送邮件、不创建 DocuSign 信封。

## 账号配置

采用服务端 JWT grant，凭据只放本地 `.dev.vars` 或 Worker secrets：

| 名称 | 用途 |
| --- | --- |
| DOCUSIGN_ENVIRONMENT | demo 或 production，显式选择 |
| DOCUSIGN_INTEGRATION_KEY | 已有应用的 Integration Key |
| DOCUSIGN_USER_ID | 有发送权限、已授予 consent 的用户 GUID |
| DOCUSIGN_ACCOUNT_ID | 目标 eSignature API account ID |
| DOCUSIGN_PRIVATE_KEY | RSA 私钥，服务端保管 |
| DOCUSIGN_CONNECT_HMAC_SECRET | Connect 回调验签密钥 |
| DOCUSIGN_WEBHOOK_URL | 本应用可访问的 HTTPS 回调地址 |

JWT 需要 `signature impersonation` scopes 和有效 consent。
通过 OAuth userinfo 核对账号并发现 base URI，不硬编码 production shard。
开发环境默认停用真实发送；sandbox 联调需显式启用，使用指定测试收件人。
本地真实 sandbox 测试需要 HTTPS callback（测试部署或现有 tunnel），否则无法验证自动回写。
现有 Resend 本地邮件拦截不会拦截 DocuSign 自己发出的签署邀请。

## 验收

- 权限：Admin、assigned Agent、collaborator 可发；其他 Agent、landlord、tenant、owner 不可发。
- 多 tenant 独立收件人和签名位置正确，landlord 在最后；正文与冻结版本一致。
- 未批准、资料不全、邮箱错误、缺少 anchor、审阅后被修改时阻止发送。
- 双击、并发、创建响应丢失、send 响应丢失与过期 transaction 恢复不生成重复邀请。
- 假 HMAC、错误 account、未知 envelope、重复/乱序回调不推进错误合同。
- 拒签、作废、签完、归档失败、任务锁到期都正确呈现且能恢复。
- 运行 typecheck、gate、rentals、workspace、隔离数据库及 browser 回归。
- 使用 sandbox 实际完成两位 tenant → landlord → signed PDF/certificate 全链路，
  检查每处签署坐标、页数和文件可下载。Mock 成功不等于 sandbox 验收。

## 官方资料

- [JWT grant](https://developers.docusign.com/platform/auth/jwt-get-token/)
- [创建信封](https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/envelopes/create/)
- [AutoPlace anchors](https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/tabs/auto-place/)
- [Connect HMAC](https://developers.docusign.com/platform/webhooks/connect/hmac/)
- [transaction ID 恢复与七天期限](https://www.docusign.com/blog/developers/common-api-tasks-use-transactionid-to-find-the-envelope-you-created)


## 本地配置与正式部署

本地 `.dev.vars` 和 `.dev.vars.example` 已包含配置项，默认为关闭发送。
不要把私钥放在浏览器、提交到 Git，或贴进任务对话。

1. 在开发 Supabase 依次应用 `schema.sql`、`backoffice.sql`、`workspace.sql`、
   `rental-flow.sql`、`rental-signing.sql`（已经应用的基础迁移不必重跑）。
   新增 migration 已用 PGlite 验证可重复应用。
2. `.dev.vars` 设置 `RENTAL_AUTOMATION=on`、`DOCUSIGN_ENABLED=on`、
   `DOCUSIGN_ENVIRONMENT=demo`；填入 sandbox Integration Key、User ID、API Account ID、
   RSA 私钥和 Connect HMAC secret。支持 PKCS#1 和 PKCS#8 PEM。
3. 给发送用户授予 JWT consent：在 Integration Key 中登记 callback URI，使用
   `https://account-d.docusign.com/oauth/auth`，参数为 `response_type=code`、
   `scope=signature impersonation`、你的 `client_id` 和已登记的 `redirect_uri`。
   登录后允许访问即可；本实现不使用回跳里的 authorization code。
4. 配置指向本机 Worker 的 HTTPS tunnel，或使用测试部署；
   `DOCUSIGN_WEBHOOK_URL` 必须为该地址的 `/api/webhooks/docusign`。
   本地先在另一个终端运行 `npm run dev:webhook`，让 tunnel 指向它的 `127.0.0.1:8788`。
   此入口只转发 `POST /api/webhooks/docusign` 到本机 Worker，保留原始 body 和 HMAC headers，
   其他路径返回 404；不要将整个后台开发服务作为 tunnel 的目标。
   Worker 端口默认 8787，可通过 `PORT` 调整；转发端口可通过 `DOCUSIGN_FORWARD_PORT` 调整。
   在 DocuSign Connect 配置 HMAC key；此实现为每个信封注册 JSON 回调，不依赖通用账号回调。
5. 显式设置 `DEV_DOCUSIGN_SEND=on` 后，运行 `npm run dev:signing`。
   此命令固定使用 DocuSign demo 环境，并每分钟调用 Wrangler 本地 scheduled handler，
   执行现有 rental 和 signing 的到期任务；关闭开发进程即停止定时执行。
   使用开发数据库中的有效 staff 身份；若使用 `DEV_ADMIN_EMAIL`，这个邮箱也须在
   `staff` 表中有 active Admin/Agent 记录，因为发送事务会重查权限。
6. 使用测试收件人完成申请组、房东同意、**Review Signing Package → Review Lease Draft**，
   在平台核对合同后 **Send With DocuSign**；或从 Rental 确认跳过审核后发送。界面每次刷新只读取本地签署记录，不直接轮询供应商。
   首次发送与收到回调会立即启动持久化任务；定时任务负责补偿。
   普通 `npm run dev` 不启动这个本地定时器。
7. 依次完成 tenants 和 landlord 签署，检查每个签署位置，下载 PDF 与 certificate。
   原主合同支持最多八位租客；复杂长姓名及实际 DocuSign 转换排版仍需 sandbox 验收。
   平台位置审核已完成；接下来验证 sandbox 转换和实际签署。此项不能由 mock 测试替代。

生产使用相同代码，但必须使用已完成 Go-Live 的生产 Integration Key、生产 sender
+ account，并在 `account.docusign.com` 重新获取 consent。
设置 `DOCUSIGN_ENVIRONMENT=production`，使用正式 HTTPS webhook 及生产 Connect HMAC key，
将凭据配置为 Worker secrets。生产开启 `RENTAL_AUTOMATION` 和 `DOCUSIGN_ENABLED` 前先应用 migration。
`DEV_DOCUSIGN_SEND` 只作用于 demo 账号；loopback 请求始终拒绝 production 发送。
代码从 OAuth userinfo 发现账号所在的 API base URI，无需手动填写 na/eu 等 shard。

开发演示的 mock screening 仍仅限 localhost；DocuSign 接入没有补齐真实 credit provider。
真实申请须满足既有 screening evidence gate 才能发出合同。

## 验证结果

已验证：签名 anchors 与多人字段、PKCS#1/PKCS#8 JWT、provider 请求结构、HMAC、
创建响应丢失恢复、签署顺序、取消、归档失败重试、数据库权限与并发锁、HTTP 权限和
审阅版本、发送面板，以及原 Rental 浏览器回归。
单元测试验证最多八位租客的字段分配、每份独立源文件的定位文本、原有样式和资源保留、
单租客副本隔离、签署日期和条件性减免字段。浏览器验证全部位置预览、逐字段跳转、
多人副本切换以及返回完整文档。HTTP 测试验证合并版和单份源文件的权限与 hash。
2026-09-18 已完成单租客 Sandbox 实际发送：16 份文档、63 个签写字段，
供应商返回 `sent`，平台记录为 `in_progress`。发送前检查了 DocuSign 转换后的
PDF 和实际字段坐标；尚未验证租客与房东完成整个签署流程。

创建 DocuSign 草稿需转换多份 DOCX 并定位 anchors，客户端为该请求保留 120 秒，
普通 API 请求仍为 30 秒。超时不等于供应商未创建信封；恢复必须先按原 transaction ID
查询，不能新建替代请求。参考 [DocuSign 长耗时 createEnvelope 指南](https://www.docusign.com/blog/developers/the-trenches-managing-long-running-createenvelope-calls)。

冻结签署包的坐标以 CSS pixels（96/in）保存，发送给 DocuSign 时换算为 inches，
避免供应商 PDF 的 DPI 改变位置或导致 `INVALID_USER_OFFSET`。v4 模板另有经过
供应商实际 PDF 核对的表格行偏移校正；多人第二排仍需独立的实际签署验证。
参考 [DocuSign 字段定位指南](https://www.docusign.com/blog/developers/select-the-right-tab-placement-strategy-for-your-docusign-integration)。

DocuSign 的 anchor 匹配范围可能是整个信封，因此不能仅依赖 `documentId` 隔离。
发送前按稳定字段标签检查实际 tabs，删除匹配到其他文档的副本，并要求每个预期字段
在目标文档中恰好出现一次。有缺失、重复或未知字段时停止发送。旧草稿的行坐标迁移
使用版本化标签防止重复位移，保持原信封、文档内容和收件人不变。
参考 [DocuSign anchor 匹配范围说明](https://www.docusign.com/blog/developers/envelopes-dynamic-number-signers)。

```sh
npm run test:signing
npm run test:signing:db
npm run test:signing:ui  # 需要 Playwright，可通过 PLAYWRIGHT_MODULE 指定
npm run test:rentals
npm run test:rentals:db
npm run test:rentals:ui
npm run test:workspace
npm run typecheck
npm run gate
npm run build
```


### 2026-09-18：签发后的状态反馈与邮件投递排查

租约审核页之前只在发送的 202 响应后读取一次记录；文件仍在准备时便停留在
`preparing`。`View Signing Status` 只重新渲染已有数据，既不请求后台，
也不清除旧的签字位置预览提示。现在审核页每五秒读取平台保存的签署状态，
按钮明确刷新并显示查询时间；离开页面停止轮询，后台标签页和编辑时暂停。
刷新不重新渲染合同，也不会调用发送接口。页头和收件人列表使用同一状态源。

供应商接受发送后，第一签署顺序的租客状态记录为 `sent`，房东继续等待。
旧记录遗留的第一顺序 `pending` 仅在已保存的信封状态为 sent/delivered 时
作兼容显示。`sent` 不能证明邮件进入收件箱；`delivered` 表示收件人打开签署链接。
`autoresponded` 映射为 `delivery_failed`，保留有限长度的退信原因，
同步流程标记 needs_attention；新信封也订阅 recipient-autoresponded 回调。

本次测试申请 `b446fac4-5573-4541-b072-ff0d1eac5cbc` 的同一信封
`890224c1-e3d4-80ae-816a-55fac2991231` 于 20:03:22 UTC 进入 sent，
DocuSign audit_events 包含 Sent Invitations。收件人为已配置测试邮箱，
租客 routingOrder=1、房东=2，deliveryMethod=email，未设置 clientUserId。
排查时未返回 autoresponded 或退信原因，但用户确认收件箱及垃圾邮件未收到。
20:13:58 UTC 对原信封执行一次 resend_envelope，供应商返回 HTTP 200；
未创建替代信封、未修改任何合同内容或收件地址。用户在补发后再次确认仍未收到。
发送人邮箱未发现本次异常通知；租客不属于配置的发送账号，无法读取其独立账号的通知偏好。
供应商接受请求不等于邮箱交付成功，尚需 DocuSign 出站队列/SMTP 日志定位。

排查依据：
- https://www.docusign.com/blog/developers/from-the-trenches-enhancing-email-delivery-with-docusign
- https://www.docusign.com/blog/developers/from-the-trenches-how-to-fix-missing-docusign-email-notifications
- https://www.docusign.com/blog/developers/common-api-tasks-resend-your-envelope-programmatically
