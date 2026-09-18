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
正文、表格、样式及资源，不重排签字表格、不增加日期栏、不扩展或删除下划线。
每个文件单独绑定签署字段，避免多个 rider 使用相同文字时定位到其他文件。

2026-09-18 起按用户要求逐份确认。已配置主合同 **New York Residential Lease Agreement**：

- 第 38、39 条：每位租客各一处 Initials，按原有八条下划线分配。
- 第 47 条：每位租客一组 Signature / Print Name，使用原有两排、每排四个位置。
- 第 47 条：房东签署人一组 Signature / Print Name；姓名来自个人签署人而非公司名。
- 超过八位租客明确报错，不改变原稿排版。

`site/shared/lease-signing-layout.js` 保存主合同字段清单，使用原文中唯一的条款标题和
执行段落定位；源模板 hash 改变、定位文本缺失或重复时停止准备。
E-sign Recipients 提供 **Preview Signing Fields**，每位收件人下的字段按钮可跳转至
对应原有下划线，蓝色表示租客、紫色表示房东；Print Name 显示该收件人的全名。
预览覆盖层仅用于平台核对，不写入合同。

2026-09-18 主合同平台预览已获用户确认；同批新增 Utilities – Simple Form、Packages Rider、
Key Rider、New York Renters Insurance Rider、Community Rules Rider、Fine Schedule。
六份均按各自原有八个租客位及一个房东位配置 Signature / Print Name，不增加日期。
Packages 的表格有额外空段落，Key 的行距和列宽不同，分别保存测量值与预览映射。
Fine Schedule 仍属于原文档导航中的 Community Rules 范围，但签署预览可独立选择。
E-sign Recipients 中通过 Document 下拉框切换位置预览。

其余九份的配置如下，发送继续暂停，等待用户核对与供应商转换验证：

- Window Guards：租客 Signature / Date Signed。
- Bedbug：租客和房东各 Signature / Date Signed。
- Indoor Allergen：仅房东 Signature / Print Name / Date Signed。
- DHCR：租客和房东各 Signature / Date Signed。
- Sprinkler、Gas/CO/Smoke Alarm、Smoking、Good Cause：沿用原有租客和房东 Signature / Print Name。
- Rent Concession：只有填写实际减免条款时才配置 Signature / Print Name；空值、None、N/A 等不产生签署字段。

Window Guards、Bedbug、DHCR 原稿只有一组租客签字线，为每位租客生成独立副本，
分别填入该租客资料，并通过 **Tenant Copy** 切换预览，避免多人字段重叠。
其余表单沿用原有八个租客位置。Date Signed 由 DocuSign 在对应收件人签署时填写。
平台校验每份已保存源文件的 hash 后显示覆盖层；预览内容不写进合同正文。
平台覆盖层和本地 Word 渲染不能证明 DocuSign 转换后的最终坐标准确；真实发送前仍须
核对 DocuSign sandbox 转换后的 PDF 与字段。

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
回调仅作为同步提示，后端从 DocuSign 读取已绑定 envelope 的当前状态和 recipient IDs，
不能接受回调携带的任意文件 URL、rental ID 或邮箱来直接写签署结果。

回调去重和待处理任务持久化成功后才返回 2xx；存储失败返回可重试错误。
领取任务后按当前 provider 状态更新，重复/乱序事件不回退已完成状态。
创建 draft 时抢先到达、尚未绑定 envelope ID 的事件保留待关联。
cron 处理已保存任务和失败归档；provider 状态查询按官方限制安排，不在现有每分钟
reconciliation 中对所有信封高频轮询。普通补偿查询间隔为 31 分钟；
同一信封的状态读取预算持久化，回调提示触发的重复读取也至少相隔 16 分钟。
因此短时间内连续签署时，页面状态可能延后最多约 16 分钟再同步，归档失败会继续重试。

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
   当前应先完成全部文件的签署位置核对，再解除发送暂停。此项不能由 mock 测试替代。

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
没有真实 DocuSign 发送或 sandbox 签署结果。

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
