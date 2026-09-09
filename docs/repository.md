# 仓库维护与交付记录

## 哪些内容进入 Git

| 内容 | 位置 / 规则 |
| --- | --- |
| 网页、Worker、后端模块、SQL、测试工具 | `site/`、`worker/`、`backend/`、`supabase/`、`scripts/`、`lease/` |
| 可复现安装与配置样例 | `package.json`、`package-lock.json`、`.dev.vars.example`；样例不得填写真实密钥 |
| 运行必需的租约源模板 | `lease/template/*.docx`，保留追踪；不要放入已填写的真实租约 |
| 合成测试附件 | `scripts/demo-assets/`；只包含 mock 数据 |
| 架构、设计、实现状态 | `backend/README.md`、`backend/RINGS.md`、`docs/backoffice/` |

PDF 与 DOCX 在 `.gitattributes` 中标为二进制，保持原始字节，不对其内部格式做文本合并或空白修正。

## 哪些内容留在本地

- `.dev.vars`、`.dev.vars.*`、`.env`、`.env.*`：本地凭据；仅 `.example` 样例例外。
- `notes/`：需求表、反馈文档、原始租约和设计草稿。这个目录不随 clone 同步，需要另行保管。
- `dist/`、`node_modules/`、`.wrangler/`：构建产物、依赖和本地运行状态。
- `.playwright-mcp/`、`playwright-report/`、`test-results/`、`coverage/`、日志与系统缓存：可再生成的输出。

2026-09-09 整理时，根目录需求表移至 `notes/requirements/lease-information-2026-09-02.xlsx`，两份反馈 Word 移至 `notes/requirements/`，原始 Kew Gardens 租约移至 `notes/lease-import/`。已有资料未被覆盖。浏览器日志、快照与 `.DS_Store` 已清除；本地凭据及运行中的 demo 数据未改动。

不要用不加区分的 `git clean -fdx` 清理工作区：它也会删除被忽略的凭据、参考资料和本地数据。

## 本次提交顺序

这些改动在工作区中累积形成，无法可靠还原每次编辑发生的时间。本次按依赖和功能进度拆分，使用实际提交时间，保留既有历史；没有回填或伪造日期。

| 顺序 | 提交 | 交付阶段 |
| --- | --- | --- |
| 1 | `ab8594c` | 仓库卫生：忽略本地产物并保留源模板 |
| 2 | `4f45495` | 六边形架构：契约、核心流程、适配器、架构检查和本地 v2 入口 |
| 3 | `21638bf` | 权限与入驻：角色范围、Owner 账户治理、房东与物业审核、SQL 和回归测试 |
| 4 | `a06c1db` | 品牌：公共页面与申请页面内嵌 Star 标志 |
| 5 | `cd4bfd5` | 后台：角色工作台、账户与入驻界面、15 步租约设置和跟随选中项的导航 |
| 6 | `8b26714` | 模拟与验证：合成物业和租约数据、mock 附件、回归工具与 CI 入口 |
| 7 | 本文所在提交 | 文档：整理设计、实现进度与仓库维护规则 |

这是一组代码交付检查点，不代表生产上线。第三方 screening、签署等集成和环境准备仍以 [后台实现记录](backoffice/implementation.md) 与 [后端说明](../backend/README.md) 为准。

## 验证入口

先执行 `npm ci`。CI 使用 Node.js 24。

```bash
npm run typecheck
npm run gate
npm run test:workspace
npm run test:portal
npm run test:administration
npm run test:property
npm run test:demo
npm run build
python3 lease/tools/check-fields.py
node lease/tools/test-lease.mjs
node lease/tools/test-permissions.mjs
```

隔离数据库测试通过 PGlite 执行，不要求连接真实 Supabase。自行安装 `@electric-sql/pglite`，或将 `PGLITE_MODULE` 设置为本地已安装模块的绝对入口路径后执行：

```bash
node lease/tools/test-schema.mjs
node lease/tools/test-backoffice-schema.mjs
npm run test:workspace:db
npm run test:administration:db
```

本次整理已通过上述检查；拆分后的后端与品牌、后台界面快照也分别通过构建检查。另有 `npm run smoke` 的本地 HTTP 流程检查，以及 `scripts/test-backoffice-ui.mjs` 浏览器回归工具；本次整理未运行这两项，不能将已通过的单元、数据库和构建检查视为生产端到端验收。
