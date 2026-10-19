# 代码风格与公共接口约定

这些是实现约定；已有身份 API 见 docs/API.md，页面接入见 docs/WEB_IDENTITY.md，人工模块边界见 docs/HUMAN_HANDOFF.md。固定差旅草稿、提交、通过/驳回/撤回与详情 API 已实现；本人通知列表/详情/未读数/已读 API 也已实现，受控差旅附件 API 也已实现；差旅草稿、附件、提交与只读详情页面已接入，S3g 已有全状态申请与待办/已办列表 API，S3h 已接入列表与审批/撤回 UI，S3i 已接入通知列表/详情、未读数、显式已读与前台轮询（WEB_NOTIFICATIONS.md）。固定差旅页面边界见 WEB_TRAVEL.md。

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
