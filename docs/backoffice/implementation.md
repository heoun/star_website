# 三种角色后台：实现与启用

当前正式入口仍是 `/admin/`。本次保留现有 Supabase applications、文件、物业字段注册表和 Word 租约引擎，将工作流和权限提取为独立模块。`manager` 在界面显示为 **Admin**，不改已有角色值。

## 已实现的工作方式

Admin 首页是全局 Dashboard，聚合待审核入驻、待分配申请、物业修改请求与租赁进度。Agent 和 Landlord 首页继续以待办为主。每个申请显示当前负责方和下一步；申请材料、条款、备注和历史按需展开。

| 能力 | Admin | Agent | Landlord |
| --- | --- | --- | --- |
| 工作范围 | 全部申请，分配负责人/协作者 | 自己负责或参与协作的申请 | 本人收到的推荐，且仍拥有该物业访问权 |
| 审核申请/信用报告 | 可以 | 仅限负责/协作申请 | 不参与，不接收原始申请和审核文件 |
| 内部批准 | 可以 | 可以，无需重复找 Admin 批准 | 确认租赁建议，不做内部审核 |
| 单次租赁条款 | 编辑七个交易字段 | 编辑同样七个字段 | 查看并同意、要求修改或拒绝 |
| 物业默认条款 | 维护、审批并发布修改建议 | 查看、提交建议 | 提交建议 |
| 营销房源 | 全部管理 | 浏览已发布房源；编辑明确分配的营销物业 | 查看分配的物业，提出修改请求 |
| 私密信息 | Admin 私密备注；按需揭示完整身份号码 | 团队备注、审核资料、身份号码末四位 | 不返回身份号码、生日、收入或内部备注 |
| 签署与归档 | 登记外部回执、上传最终 PDF | 仅负责/协作申请 | 在团队归档后下载本人租赁的最终 PDF |

Agent 的物业营销权限与申请权限分开：分配一个物业不会让 Agent 看到该物业所有租客。Landlord 的角色、当前物业分配和推荐收件人必须同时匹配。接口返回独立的房东摘要，不靠隐藏按钮保护资料。

## 已落地的流程

申请提交 → 登记费用/报告/文件核验 → Agent 或 Admin 内部批准 → 提交房东推荐 → 房东确认 → 生成并固定最终租约 → 登记全部租客签署 → 登记房东签署 → 上传签完的 PDF → 完成。

- 付款、信用检查和电子签署采用**外部处理、人工核验回执**。当前界面不会发送签署邀请、扣款或启动信用调查。
- 每个流程动作有前置条件；旧接口不能任意 PATCH status 跳步骤。
- 费用/报告/文件未核验，不能内部批准；旧 `approved` 记录不会自动被视为房东已同意。
- 推荐绑定条款版本和明确收件人。条款或原始申请变化会作废旧审核；补件也会触发重新核验。已进入签署的资料不能从员工入口随意改写。
- 最终 Word 文件生成成功时保存全部租约值；之后修改物业默认条款，不改变已准备的租约。签署回执绑定这个保存版本。最终 PDF 是外部签署完成后上传的文件，系统没有冒充供应商验证签名真实性。
- 写入采用版本比较，重复点击或并发修改返回冲突提示。决定、分配和备注有操作记录。
- 租约 PDF 保存在私有 R2 路径，每次下载重新检查访问权；取消分配后不能通过旧下载地址继续读取。
- 房东/Agent 的结构化建议由 Admin 一次审批发布到物业默认值，并在同一数据库事务关闭请求。已被别人改过的旧建议会要求重新确认。首版支持租金到期日、结束时间和 utilities；其他内容通过一般修改请求处理。

## 架构与扩展位置

| 文件 | 职责 |
| --- | --- |
| `backend/contracts/workspace.ts` | 角色、案件动作、数据边界、仓储契约 |
| `backend/core/workspace.ts` | 权限、字段投影、流程状态、条款版本 |
| `backend/adapters/workspace-supabase/index.ts` | 有范围的查询、分页、CAS 写入 |
| `backend/app/workspace.ts` | 组合根，连接旧 Worker 与新模块 |
| `worker/backoffice.js` | HTTP、身份、文件及现有租约引擎接入 |
| `site/admin/case-workspace.js` | 任务队列与三种案件视图 |
| `supabase/workspace.sql` | 增量表字段、版本和补件触发器、原子审批 RPC |

继续沿用 hexagonal architecture 的契约/核心/适配器分层，不更换技术栈。已有 `/api/v2` 用另一份案件存储及模拟供应商，现限制在本地实验；其员工路由只供 Admin 使用，不作为正式角色后台的数据来源。未来接供应商应继续使用已有 screening/esign 契约，并通过真实应用案件关联接回本工作台。

## 启用真实数据

1. 已有项目确认执行过 `supabase/schema.sql` 和 `supabase/backoffice.sql` 后，在目标 Supabase SQL Editor 执行 **`supabase/workspace.sql`**，再执行 **`supabase/administration.sql`**。新项目按这四个文件的顺序初始化。迁移是增量、可重复执行的，不给旧申请猜测负责人或房东决定。
2. `npm run build`，再用原有 `npm run dev` 或部署流程运行 Worker。不能用 `file://` 打开后台 HTML 代替 Worker。
3. 配置 `OWNER_EMAIL`（建议作为 Worker secret 保留）。只有这个经过 Cloudflare Access 验证的身份能授予/撤销 Admin 权限；Owner 不存成可编辑角色。Admin 在 Accounts & access 管理 Agent / Landlord 账号和物业权限，在申请内分配负责人/协作者。正式登录仍需 Cloudflare Access 与 active staff 记录，Owner 是配置中的例外。
4. 真实信用检查、费用核验、签署服务仍按外部流程操作并登记凭证。

**2026-09-08 验证状态：**对当前开发 Supabase 只做了 `limit=0` 字段探测，返回 `42703`，新增字段尚未可用。迁移已在隔离 PostgreSQL 兼容运行时验证，**未执行到真实数据库，也未部署**。当前环境只有 REST 服务密钥，没有 SQL 管理连接，不能用 REST 密钥直接执行迁移。

## 本地演示与验证

```sh
npm run demo:workspace
# 打开 http://127.0.0.1:8792/__demo
```

演示包含 Platform Owner、Admin、Agent A、Agent B、Landlord，以及新批准的房东，使用真实 Worker 路由与合成记录；不会读取 `.dev.vars`，不会连接真实 Supabase 或发消息。修改保存在系统临时目录的 `star-role-workspace-demo.json`。可设置 `DEMO_STATE` 使用另一个演示数据文件。角色选择器只存在于这个本地演示服务器。

完整 mock 数据由 `scripts/demo-data.mjs` 维护，独立于权限测试的稀疏 fixtures。每栋演示物业补齐 125 个物业级租约字段，包括房东实体、签字人、管理/通知联系人、收款与押金银行、费用、水电责任、保险、钥匙和披露选项。仅在本地演示中，没有 Listing 的物业会得到一个未发布的示例单元和申请，以便查看完整租约。申请包含工作和租住历史、推荐人、紧急联系人及各类附件样本；附件是明确标为 mock 的通用 PDF，不冒充真实身份证件、报告或已签协议。

页面字段名后显示 `(mock)`，Word 预览和生成文件的每个填写值后也带 `(mock)`。日期、数字、邮箱等存储值保持原有类型，正式站点的页面和 Word 模板不加入这些标记。独立的物业测试租约使用示例租客，不读取其他申请人的资料。首次升级先备份旧演示状态为 `star-role-workspace-demo.json.before-complete-mock.json`，只补空缺字段；后续手工保存或清空的字段会保留。费用、信用检查和签署流程仍需按演示步骤操作，不会因补齐资料自动批准案件。

`npm run test:demo` 已通过 66 项 mock 数据、租约生成、文档标记、披露一致性、独立物业预览和保存回归检查。本地静态服务同时正确发送 `.mjs` 的 JavaScript 类型，使 Word 预览模块能正常加载。

```sh
npm run typecheck
npm run gate
npm run test:workspace
npm run test:administration
npm run test:demo
node lease/tools/test-permissions.mjs
node lease/tools/test-apply.mjs
node lease/tools/test-lease.mjs
SMOKE_DB=memory npm run smoke
node scripts/check-workspace-schema.mjs # 只查字段，不打印记录或密钥
```

SQL 回归：安装可选的 `@electric-sql/pglite` 后运行 `npm run test:workspace:db`，或用 `PGLITE_MODULE` 指向现有安装。验证可重复迁移、并发版本、补件作废、租约快照、原子发布和数据库角色授权。

2026-09-09 已通过：113 项工作台检查、82 项账户/入驻 HTTP 检查、35 项账户/入驻 SQL 检查、89 项旧权限回归、103 项申请检查、35 项 Word/租约检查、工作台 SQL 回归、构建、类型检查、依赖边界检查及 v2 内存 smoke。旧账户测试中“普通 Admin 可修改其他 Admin”的断言已被新治理测试替代。浏览器此前验证了分配、Agent 范围、审核/推荐、房东确认后刷新保留、建议审批发布；本次验证了 Admin 同级账户只读、Owner 授权/撤权、邀请、草稿刷新、两栋物业提交/批准、自动绑定、新房东仅见自己的物业，以及桌面和 390px 手机布局。`scripts/test-backoffice-ui.mjs` 是同步更新的可选 Playwright 回归入口，本次浏览器验证使用桌面工具完成，没有运行该可选脚本。

## Admin 管理与房东入驻（2026-09-09）

- **Platform Owner** 负责 Admin 任命、撤权和停用；普通 Admin 无法修改同级 Admin，自己和 Owner 的账号不能从目录改动。Owner 通过 Agent 的独立授权操作授予 Admin，需说明原因，所有变化进入审计。没有任意角色下拉框。
- **Accounts & access** 分为 Admins、Agents、Landlords 三栏。内部员工与外部房东是不同账户类型；Landlord 不可转换为 Agent/Admin，员工兼任房东的需求需要后续独立成员身份模型。
- **Dashboard** 显示当前业务计数、需处理事项和快捷入口。Accounts & access、Listings 在左侧主导航中。
- **Landlord onboarding**：Admin 填联系人和邮箱 → 邮件中的私有表单链接 → 房东分步填写联系方式和 1–10 栋物业，可保存草稿 → Admin 批准、要求修改、拒绝或取消。链接 14 天有效，重发/要求修改会替换旧链接。
- **批准**在一个数据库事务内创建物业、导入提供的房东实体/签字联系人/地址及水电默认值、建立或扩展 Landlord 账户与物业分配、写审计并关闭入驻记录。地址/名称冲突会整笔拒绝，不留下半条物业，不接管别人的账户或静默覆盖旧物业。
- 房东批准后能在 **My properties** 立即看到已登记物业，即使尚未建立 Listings。表单的单元数量只是房东报告的数量；系统不猜测房号或创建虚构房源。Admin 物业页分别显示报告单元数和已关联 Listing 数。
- 入驻只收集基本物业资料和已知 utilities，不代表全部租约默认条款已齐备。剩余条款由 Admin 在 Properties 中完成，沿用既有租约就绪检查。

邮件沿用现有 Resend 发送适配器；未引入新付费服务。`email_state=sent` 仅表示发送服务接受请求，不能证明最终送达。失败保留邀请并提供重发；当前没有后台自动重试队列。邮件链接打开普通网页表单，不依赖收件箱对嵌入式互动表单的支持。

生产环境需要已验证的发信地址和 `RESEND_API_KEY`。`/landlord-onboarding/` 和 `/api/landlord-onboarding` 必须可公开到达，后者依靠不可猜测的邀请令牌；`/admin/` 与 `/api/admin/` 仍由 Cloudflare Access 保护。房东批准后还必须符合 Access 登录策略；本次不会自动调用 Cloudflare 修改用户或准入策略。后台数据库只保存令牌哈希，浏览器链接中的令牌不进入查询参数或 localStorage。

开发演示把邮件写到 `http://127.0.0.1:8792/__demo/inbox`，不会投递真实收件箱。生产发信、真实 Access 登录和目标 Supabase 迁移均未执行或验收。此前目标开发库缺少 workspace 字段，此次的 administration 迁移也尚未应用。

新增模块：`backend/contracts/administration.ts` 定义契约；`backend/core/administration.ts` 负责授权和入驻状态；Supabase、邮件和令牌分别位于 adapters；`backend/app/administration.ts` 组合接线，Worker 处理 HTTP。继续沿用现有技术栈与 hexagonal 分层。

SQL 验证：`npm run test:administration:db`，可选依赖及 `PGLITE_MODULE` 用法与工作台 SQL 回归相同。HTTP 回归已加入 CI。

## 明确留待后续的能力

- 多个申请合为一个 household case；当前一个 application.id 就是一个工作单位，不覆盖或合并原始申请。
- 真实供应商 API、付款/报告/签署 webhook、可靠自动提醒及重试/去重。
- 电子签署验证、同单元租期冲突处理、签完自动下架与其他候选处置。
- 房东提出修改/拒绝后，案件回到团队或关闭；房东不保留对原始申请的访问。独立长期推荐历史可后续增加。

当前版本提供清晰的权限和可执行的流程骨架，并非全部自动化已经上线。


## 权限范围调整（2026-09-09）

- Platform Owner 只进入 Accounts & access，负责账户权限、Admin 任免及停用/启用。Owner 不是业务 Admin，旧业务页面会回到权限页；申请、租约、入驻、房源和私密文件接口拒绝 Owner，v2 身份适配器也不再把 Owner 当业务管理员。权限分配需要的物业目录只返回 ID 和名称。
- Landlord 的 Registered properties 为只读。Admin/Owner 均不能通过账户保存增减房东绑定；保存姓名或账户状态时保留已有绑定。新房东及新增物业统一通过 Admin 审核入驻建立，不再提供手动创建并绑定房东的入口。
- 租赁队列按 All Rentals → Needs Attention → Waiting on Others 排列（Agent 的待办标签保留 Needs Me）。

此轮通过 107 项账户/入驻 HTTP 检查、40 项 SQL 检查、158 项工作台检查、66 项 mock 检查、类型检查、依赖检查与构建。SQL 仅在本地隔离运行时验证；真实环境部署需要重新执行更新后的 `supabase/administration.sql`，尚未对真实数据库执行或部署。

Owner 可在 Admins 栏直接 Add Admin，通过独立 `create_admin` 动作创建新的内部账号；邮箱已存在时不能覆盖或转换外部房东。`remove_admin` 撤销整个账号的访问（active=false，保留历史与审计），与 `revoke_admin` 降级为 Agent 分开。只有 Owner 可执行，创建/移除需要原因、版本检查，并保护 Owner 本人。移除的 Admin 保留在目录中供审计及恢复；不会物理删除案件关联。此项通过 121 项账户 HTTP/身份检查、51 项 SQL 检查及已有工作台和 mock 回归。部署前仍需更新 `supabase/administration.sql`；未部署。

Account removal now covers Agents and Landlords with `remove_account`, available to Admin and Platform Owner. It requires an active Agent/Landlord, current account version and a removal reason; it cannot target Admins, the caller or the protected Owner. The command preserves the account type, property bindings and historical records while setting `active=false`, and records an audit event. Agent creation remains available to Admin and Owner. Admin's Landlords tab now has an explicit Add Landlord entry into approved onboarding; Owner still does not perform business onboarding. Open Agent rentals require Admin reassignment after removal.

Validation: 154 administration HTTP checks, 90 isolated PostgreSQL checks, 158 workspace checks and 66 demo checks passed, plus typecheck, architecture gate and build. Browser verification covered Agent creation/removal, the Add Landlord onboarding link, and Landlord removal/restoration with retained registered properties. All browser mutations used local synthetic data; the SQL update has not been applied to production.

Properties & settings now follows the supplied lease-entry sequence in 15 numbered sections: property address; landlord/signing; management/notices; lease terms/payments/policies; utility; keys; renters insurance; fines; bedbug; sprinkler; gas/CO/smoke; smoking policy; concession; DHCR; Good Cause. The 125 existing manager fields are mapped exactly once. A section is edited and saved independently; moving between steps requires saving or cancelling an open edit. Keys pair quantity with replacement charge, and Good Cause fields appear under the four notice questions. Insurance-required, smoking-in-unit and sprinkler choices use mutually exclusive selectors that save both underlying marks together. Readiness checks continue to cover every required field after regrouping. The shared document-side editor uses the same section model.

The provided checklist also identifies data-model work beyond this layout: standalone landlord phone and signer mailing address are not currently independent fields; DHCR contact fields must not be silently treated as the same identity. Default-following rules for legal-notice/payee/owner-representative contacts still need an explicit override policy. Vacancy date, concession and DHCR lease type remain per-rental inputs. A listing release date is not assumed to be an actual sprinkler inspection date. This change preserves stored values and does not automatically apply the checklist's defaults to existing properties.

Verification: `node scripts/test-property-flow.mjs` covers complete field mapping, 15-step rendering, readiness for every required field, scoped save, atomic paired choices and protection against losing edits. The 66 demo/lease-generation checks and build passed. Browser checks covered actual save/reload/restoration on mock data, Good Cause's four questions, desktop/mobile layout and the unsaved-step guard. No production deployment or schema mutation was made.

The compact lease-step navigation retains its horizontal button layout. After changing sections, the current step is scrolled into view within the navigation strip; editing/cancelling preserves its scroll position. Footer Previous/Next returns the reader to the start of the new section. Local section redraws reuse loaded property data instead of clearing and fetching the entire page. Browser verification covered sequential steps 1–5 at 1000px, preserved horizontal position through Edit/Cancel, and active-step visibility at 390px. The temporary dropdown approach was removed.
