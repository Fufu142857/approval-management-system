# 代码风格与公共接口约定

这些是实现约定；已有身份 API 见 docs/API.md，页面接入见 docs/WEB_IDENTITY.md，人工模块边界见 docs/HUMAN_HANDOFF.md。固定差旅草稿、提交、通过/驳回/撤回与详情 API 已实现；本人通知列表/详情/未读数/已读 API 也已实现，受控差旅附件 API 也已实现；差旅草稿、附件、提交与只读详情页面已接入，S3g 已有全状态申请与待办/已办列表 API，S3h 已接入列表与审批/撤回 UI，S3i 已接入通知列表/详情、未读数、显式已读与前台轮询（WEB_NOTIFICATIONS.md）。S3j 已实现固定差旅复制重提，来源字段不可修改，新草稿不复制附件，重提规则见 WEB_TRAVEL_RESUBMISSION.md。固定差旅页面边界见 WEB_TRAVEL.md。S4a 采购草稿后端见 API.md；数量最多三位小数，单价两位，按行 half-up 到分后求和，接口均为十进制字符串，不能使用 JS 浮点计算。

## 工程与命名

- TypeScript strict；使用 ES module。React 函数组件，优先服务端组件，需要交互时才使用客户端组件。
- 格式由 Prettier 统一：两空格、双引号、分号、尾逗号。组件 PascalCase，变量/函数 camelCase，普通模块文件 kebab-case；Next 路由遵循 page.tsx、layout.tsx、route.ts 约定。
- 数据库表与列 snake_case；API JSON 字段 camelCase，标识使用 UUID 字符串。中文界面、英文代码标识；注释解释约束与原因。
- `src/app` 放路由与页面，`src/components` 放共享 UI，`src/server` 放数据库和业务服务，`src/lib` 放公共类型/校验与客户端请求工具（api-client.ts 仅在客户端使用）；小程序未来独立放 `miniprogram`。
- 页面不直接访问数据库；Route Handler 负责 HTTP 边界，服务层负责授权、业务规则与事务。服务端模块不能被客户端组件导入。
- Next.js 16 官方文档：[安装](https://nextjs.org/docs/app/getting-started/installation)。Tailwind 4 配置：[PostCSS 集成](https://tailwindcss.com/docs/installation/using-postcss)。

## 界面约定

外观以外层 Design.pdf 为准，修改前查看对应原型，执行 [UI_GUIDELINES.md](UI_GUIDELINES.md) 的对照流程。复用 AccountShell、Icon 与 globals.css 中的公共控件；不得自行引入新配色或替换原型布局。没有独立原型的页面沿用公共规范，并在验收记录中如实说明。

## HTTP 约定（业务部分待 S2–S4 实现并冻结）

- API 前缀 `/api`，默认 JSON；附件上传用 multipart/form-data，成功下载为二进制，其余成功响应 `{ data: ... }`，错误响应 `{ error: { code, message, fieldErrors? } }`。
- 400 输入无效，401 未登录，403 权限不足，404 不存在或需要隐藏的资源，409 并发状态已变/唯一冲突，413 附件超限，415 不支持的媒体类型，500 未预期错误。错误不包含 SQL、密码、会话令牌或堆栈。
- 列表采用 `page` / `pageSize`，服务端限制上限；返回 items、total、page、pageSize。具体字段与默认值在实现时记入接口文档，不提前虚构端点。
- 金额传十进制字符串（如 `"1250.30"`），数据库 `NUMERIC(14,2)`，运算使用精确十进制或整数分；不能用 JavaScript 浮点合计决定审批路径。
- 日期传 `YYYY-MM-DD`；时间点传含时区 ISO 8601，数据库 TIMESTAMPTZ。差旅天数按自然日含首尾，按 Asia/Shanghai 解释，服务端计算。
- 申请人、所属部门、实际审批人、系统编号和时间由服务端确定。客户端传同名身份字段也不能取得额外权限。
- Web 与小程序共用鉴权和服务层。Web 使用 HttpOnly Cookie，小程序协议使用 Bearer，详见 API.md；不能以客户端固定用户 ID 代替认证。页面不要导入数据库模块，服务端页面通过 page-auth.ts 做检查，管理 API 保留独立鉴权。

## 一致性、安全与质量

- 申请状态、待办、日志和通知同一数据库事务提交。审批/撤回并发使用行锁或条件更新，失效请求返回明确冲突；通知按事件与接收人去重。
- 普通员工只访问本人业务；审批人仅访问被授权任务及必要资料；管理员配置权限不等于业务正文或附件访问权。列表、详情、附件和统计都执行服务端检查。
- 提交时固定路径、规则和实际人员快照。已提交记录与日志不能物理删除或回到草稿；重提创建新记录并引用原记录。
- 上传只允许 JPEG/PNG/PDF，校验真实格式、大小和数量，存储在公共静态目录外；预览/下载必须鉴权。现有差旅附件上传/删除必须带申请 version 并递增；文件与数据库补偿、72004 存储锁顺序和孤儿回收见 DATABASE.md，不允许先删原文件再提交元数据事务。
- 每次完成当前阶段运行 lint、typecheck、format:check；界面或工程配置改变时构建并检查运行结果。业务开始后引入 Vitest，重点验证金额、权限、日期、并发与回滚，不为装饰性改动堆积无意义测试。
- 提交前更新开发日志，标明 AI 协助范围与用户独立范围；不把未执行验证标记为通过。

S4b 采购报价附件与差旅共用私有存储/格式校验/回收；报价 FK 保证同单，不允许改绑元数据。含附件报价不可通过 PUT 省略删除，需先显式 DELETE 附件并使用新 version；整单删除先元数据事务再回收。文件操作锁顺序为组织 → 存储 → 申请，读取锁申请直至取完文件字节，详见 API.md/DATABASE.md。

S4c 提交与提交后详情见 API.md；采购 fixed-purchase-v1 按用户确认采用 department_head → company_head，不能套用差旅财务路径。提交只接收 version，锁后重读持久化明细/报价/附件；BigInt 精确验证金额，缺失报价金额以 null 表示未知，不用于最低价比较。草稿与提交后文件读取路径分开，后者按实际已激活任务授权。S4d 采购审批动作沿用申请锁及不可变人员快照，不得重新解析当前角色替换已提交人员。

S4e 采购列表的摘要字段和筛选在 API.md 定义：金额为数据库精确字符串/null，待办/已办按实际任务及激活/完成时间，status 筛选申请当前状态；列表总数与条目必须同一 SQL 快照。不得从角色扩大本人申请权限，也不得将取消任务计为已办。单次读取只表示查询时状态，后续写操作仍需重新核最新 taskId/version。

S4f 采购 UI 约定见 WEB_PURCHASE.md：固定字段/行明确定义；PUT 只传输入字段并保留既有行 ID。金额预览先共享 schema 规范化再 BigInt 计算，不能直接拿未补零字符串调用 purchaseLineCents。附件绑定已保存报价 ID，写入递增同一申请 version；不得用文件操作的响应覆盖未保存表单。冲突或不确定写入保留输入并停止写入，人工核对后重读，不自动重试。

S4g 固定采购完整字段校验集中在 src/lib/purchase-submission.ts；调用 purchaseSubmissionIssues 前必须用 purchaseDraftSchema 解析规范化。只检查字段与附件元数据，不替代服务端事务、身份、真实文件和配额验证。前端先保存当前内容，再使用返回的最新 version 提交；保存结果不确定不得继续提交，提交结果不确定须停止写入并核对详情。只读详情按版本/状态匹配正文与附件；未知报价金额明确显示无法比较。通知只对 travel/purchase 建立固定详情链接，每次进入正文/文件仍独立鉴权。

S4h 采购列表和动作 UI 见 WEB_PURCHASE_APPROVAL.md。列表显示的申请状态与节点结果分别保留；金额字符串/null 不通过 Number 重算，不跨业务合计。服务端传 viewerId 仅用于展示控制，API 仍独立授权；审批必须用当前实际 taskId 和最新 version，不从角色选取任务。动作成功重读正文与附件，不自动批准下一节点；冲突和不确定写入暂停、保留当前页意见，重读后再确认。类型切换导航到独立差旅/采购路由，重置筛选，不合并不同列表口径。

S4i 采购复制重提使用专用 GET/POST，不能重用差旅路径。来源只读、原记录不可修改；新采购明细/报价使用新 ID，普通编辑仅保留新单自己的行 ID。复制保留 NUMERIC 精度及未知金额/单一来源语义，不复制附件；提交重查线上证据、预算、比价和当前实际审批人。并发只复用已有后续，不能覆盖用户修改；任何复制失败先 GET 核对，不自动重放。契约与锁顺序见 API.md / DATABASE.md。
