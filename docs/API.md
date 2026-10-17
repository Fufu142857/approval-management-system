# 身份、组织与差旅草稿 HTTP 接口

S2b 身份接口由 S2c Web 页面接入；S3a 增加差旅草稿接口，尚无对应页面、提交审批、附件、通知或自定义流程接口。验收状态见 [STATUS.md](STATUS.md)，身份页面与浏览器验证见 [WEB_IDENTITY.md](WEB_IDENTITY.md)。所有成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "fieldErrors"? } }`；全部响应禁止缓存。

## 会话与请求约定

- 请求正文使用 application/json，最大 16 KiB；字段以严格白名单验证，未知字段返回 400。登录使用用户名，暂不支持邮箱登录。
- Web 登录默认 `client: "web"`，令牌只写入 `approval_session` Cookie，HttpOnly、SameSite=Lax、Path=/、固定有效期 8 小时。HTTPS 部署必须设置 `SESSION_COOKIE_SECURE=true`；本地 HTTP 为 false。页面不要把会话存入 localStorage。
- 小程序登录指定 `client: "mobile"`，JSON 返回 token；后续显式发送 `Authorization: Bearer <token>`。本轮仅提供协议，小程序界面尚未实现。数据库只保存令牌 SHA-256 摘要。
- 写请求若有 Origin，必须等于 `.env` 的 APP_ORIGIN，禁止跨站 Sec-Fetch-Site。Cookie 认证写请求必须带同源 Origin；原生 Bearer 请求可不带 Origin。注册/登录允许无 Origin 的原生 JSON 请求。本服务未开启跨域 CORS。
- 同时提供 Authorization 和 Cookie 时，使用 Authorization；无效 Authorization 不回退 Cookie。
- 注册状态为 pending，仅有 employee 角色且 departmentId=null。pending 可登录查看个人信息，但不能访问管理接口；后续业务必须要求 active，不能仅凭登录即放行业务操作。
- 每个用户名 15 分钟内最多 10 次登录请求（成功也计数），第 11 次返回 429；窗口到期重置，不因进程重启清空。它是账户级限流，不替代部署入口的总体流量防护。
- 确认、角色/部门/状态变更会撤销目标用户的全部会话，需重新登录。禁用账户不能登录。退出只撤销当前会话。

## 接口清单

| 方法与路径                        | 权限                 | 请求/结果                                                                                  |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| GET /api/health                   | 公开                 | Web 进程存活，不检查数据库                                                                 |
| GET /api/departments              | 公开                 | active 部门数组，每项 id/name；注册选择用                                                  |
| POST /api/auth/register           | 公开                 | username/fullName/email/password/requestedDepartmentId；201 返回 UserIdentity，不自动登录  |
| POST /api/auth/login              | 公开                 | username/password/client?；200 返回 user/expiresAt，mobile 另含 token，web 使用 Set-Cookie |
| GET /api/auth/me                  | 已登录，允许 pending | UserIdentity                                                                               |
| POST /api/auth/logout             | 当前凭据，可重复调用 | 无正文；200 `{ loggedOut: true }`，清除 Cookie；Cookie 请求需同源 Origin                   |
| GET /api/admin/users              | active system_admin  | page/pageSize/status?；分页 UserIdentity，按 created_at DESC/id 排序                       |
| GET /api/admin/roles              | active system_admin  | 五种角色 code/name 数组                                                                    |
| PATCH /api/admin/users/:id/access | active system_admin  | departmentId/status/roles/reason；返回变更后的 UserIdentity                                |
| GET /api/admin/audit-logs         | active system_admin  | page/pageSize；分页审计，按 created_at DESC/id 排序                                        |

分页默认 page=1、pageSize=20，page 最大 100000、pageSize 最大 100。结果 `{ items, total, page, pageSize }`；用户状态筛选 pending/active/disabled。列表与计数是独立查询，并发变更时总数可能有短暂差异。

用户名去前后空白并转小写，正则 `^[a-z][a-z0-9_]{2,31}$`；姓名去空白后 1–80 字符；邮箱合法、最多 254 字符并转小写；注册密码 8–128 字符，不自动 trim；申请部门必须是有效 UUID 和 active 部门。用户名、邮箱的数据库唯一索引处理并发注册冲突。

UserIdentity 字段：`id, username, fullName, email, requestedDepartmentId, departmentId, status, roles`。不返回 password_hash 或会话摘要。资料修改、密码重置、部门增删改没有实现；前端不得构造不存在的接口。

授权请求 status 只能是 active/disabled，departmentId 必须有效且 active；roles 不重复、必须包含 employee，并仅可选择 employee/department_head/finance_approver/company_head/system_admin；reason 去空白后 1–500 字符。不能修改自己的部门/状态/角色，返回 409，避免最后一名管理员自行撤权。系统管理员角色不自动授予任何固定业务审批权。

授权事务采用组织管理锁 72002，获得锁后重新验证操作者会话和权限，然后锁定目标用户。用户字段、角色替换、旧会话删除、审计记录一次提交或全部回滚。并发互相撤权时不会失去最后一名有效管理员。后续组织权限写入必须沿用同一事务锁和重新鉴权规则。

审计项：`id, actorId, operation, targetId, before, after, reason, createdAt`。本轮新增 operation=user.access_changed；before/after 是变更前后 UserIdentity。只提供读取接口，不提供审计编辑/删除。

## S3a 差旅草稿

仅允许已登录、active 且当前确认部门有效的用户访问**本人**草稿。待确认返回 403；失效/过期/已停用会话返回 401；系统管理员、同部门负责人也不能访问他人的草稿，详情/保存/删除统一返回 404。当前没有管理端业务正文授权。

| 方法与路径                    | 请求                         | 成功响应                                               |
| ----------------------------- | ---------------------------- | ------------------------------------------------------ |
| POST /api/travel-drafts       | 下表可编辑字段，允许 `{}`    | 201，完整 TravelDraft                                  |
| GET /api/travel-drafts        | page/pageSize/keyword?       | 200，`{ items: TravelDraft[], total, page, pageSize }` |
| GET /api/travel-drafts/:id    | UUID                         | 200，完整 TravelDraft                                  |
| PUT /api/travel-drafts/:id    | 可编辑字段及必填整数 version | 200，保存后的完整 TravelDraft，version 加 1            |
| DELETE /api/travel-drafts/:id | JSON `{ "version": 1 }`      | 200，`{ id, deleted: true }`                           |

列表固定为本人 travel/draft，按 updatedAt DESC、id 排序。分页边界沿用身份接口；keyword 最多 200 字符，去两端空白后按标题或编号进行不区分大小写的子串匹配，`%`、`_` 是字面字符。列表和计数在同一 SQL 快照内产生；超出末页返回空 items 与真实 total。当前不支持跨业务、业务状态或时间筛选；未知查询字段返回 400。

| 可编辑字段              | 类型与约束                                            | 缺省值 |
| ----------------------- | ----------------------------------------------------- | ------ |
| title                   | 去两端空白，最多 200 字符                             | `""`   |
| departure / destination | 出发地/目的地，分别最多 200 字符                      | `""`   |
| startDate / endDate     | `YYYY-MM-DD` 或 null，0001–9999 年的真实日期          | null   |
| purpose                 | 出差目的，最多 2000 字符                              | `""`   |
| companions              | 同行人员文本，最多 1000 字符                          | `""`   |
| transportation          | 交通方式文本，最多 100 字符                           | `""`   |
| budget                  | 非负十进制**字符串**或 null；最多十二位整数、两位小数 | null   |
| remarks                 | 备注，最多 2000 字符                                  | `""`   |

文本去两端空白；正文仍受 16 KiB 总大小限制。预算范围 0–999999999999.99，不接受 JSON number、负数、指数、前导零或超过两位小数；返回时统一两位小数，例如 `"0.1"` 返回 `"0.10"`。未填写预算用 null，不与零预算混同。金额通过字符串和 PostgreSQL NUMERIC(14,2) 保存，不经过 JavaScript 浮点转换。

日期表示上海时区的日历日期，不携带时刻或时区偏移。两日期都有值时结束不得早于开始，数据库计算 `durationDays = endDate - startDate + 1`，同日为 1 天，跨月/年/闰日按自然日处理；任一缺失则 durationDays=null。草稿允许不完整；未来提交接口必须再检查必填项，草稿保存通过不等于可提交审批。

PUT 是**完整替换可编辑字段**，未传字段恢复缺省值，调用端应提交完整表单。必须带最近读取的 version（1–2147483647），不匹配返回 409 VERSION_CONFLICT，不覆盖他人窗口的新内容。DELETE 同样检查版本，界面接入时必须先确认再调用；成功删除后重复请求返回 404。版本达到上限时拒绝继续编辑，但可用当前版本删除。任何非草稿记录在这些详情/保存/删除接口返回 409 NOT_DRAFT，列表不会包含它们。

TravelDraft 额外返回：`id, appNo, applicantId, departmentId, type: "travel", status: "draft", version, durationDays, createdAt, updatedAt, submittedAt: null`。申请人来自会话；部门是最近创建/保存草稿时的当前确认部门，未来提交必须重新确认并冻结。时间来自数据库，HTTP 输出 ISO 8601。上述服务器字段全部禁止由客户端提交；仅 PUT/DELETE 可按约定提供 version。附件、审批人和流程配置也不在输入白名单中。

编号在首次创建草稿时由数据库序列生成，格式 `APP-1`、`APP-2` 等，非空且唯一；后续保存和未来提交沿用，删除不回收，事务失败可以产生空号，不承诺连续。UUID 是路由标识。POST 没有幂等键，每次成功请求创建一份新草稿；不能把创建草稿的重试规则用于未来的提交审批接口。

事务取得组织锁 72002 的共享锁后重新鉴权，与管理员权限变更的排他锁互斥；同时锁定当前会话和有效部门。编辑/删除锁定申请行后检查 owner/status/version，主表和明细一起提交或回滚。未来固定业务的状态变更须遵守相同的锁顺序和申请行并发边界，不能绕过草稿冲突保护。

示例创建正文：

```json
{
  "title": "客户交流差旅",
  "departure": "杭州",
  "destination": "上海",
  "startDate": "2026-10-20",
  "endDate": "2026-10-22",
  "purpose": "项目交流",
  "companions": "",
  "transportation": "高铁",
  "budget": "1200.50",
  "remarks": ""
}
```

## 错误和接入文件

400：VALIDATION_ERROR / INVALID_JSON / INVALID_DEPARTMENT；401：UNAUTHENTICATED / INVALID_CREDENTIALS；403：FORBIDDEN / INVALID_ORIGIN；404：NOT_FOUND；409：ALREADY_EXISTS / SELF_ACCESS_CHANGE；413：PAYLOAD_TOO_LARGE；415：UNSUPPORTED_MEDIA_TYPE；429：RATE_LIMITED；500：INTERNAL_ERROR。登录错误不区分用户不存在、密码错误和已禁用。500 不回传 SQL 或异常堆栈。

差旅草稿新增：403 ACCOUNT_NOT_ACTIVE / DEPARTMENT_INACTIVE；409 NOT_DRAFT / VERSION_CONFLICT / VERSION_LIMIT。金额、日期、版本与白名单错误均沿用 400 VALIDATION_ERROR。已存在但不属于自己的草稿与不存在的 ID 均为 404 NOT_FOUND。

- `src/lib/identity.ts`：输入 schema、角色代码、UserIdentity 类型，可供 S2c 页面共享。
- `src/server/identity-handlers.ts`：HTTP 适配；`src/app/api/**/route.ts` 只导出对应处理器。
- `src/server/auth.ts`：register、login、requireUser、requireAdmin、logout；requireUser 允许 pending，不能代替业务 active 检查。
- `src/server/admin.ts`：changeUserAccess、listUsers、listAuditLogs；直接调用服务的输入必须先经过相应 schema 校验。
- `src/server/http.ts`：来源检查、正文限制、Cookie、统一错误响应。`src/server/` 仅供服务端使用，不得从 Client Component 导入。
- `tests/identity.test.ts`：真实 PostgreSQL 身份、权限、事务和并发验收；不涉及人工模块。
- `src/lib/travel.ts`：固定差旅输入 schema 与 TravelDraft；不包含动态字段解释。
- `src/server/travel-handlers.ts` / `src/app/api/travel-drafts/**/route.ts`：五个草稿 HTTP 处理器及路由。
- `src/server/travel.ts`：createTravelDraft(token, input)、listTravelDrafts(token, input)、getTravelDraft(token, id)、replaceTravelDraft(token, id, input)、deleteTravelDraft(token, id, version)。直接调用服务前必须使用对应 schema 验证输入及 UUID；共享事务规则见上文。
- `tests/travel.test.ts`：真实数据库草稿权限、校验、并发、回滚和迁移保留验证；`scripts/smoke-identity.mjs` 在原身份 HTTP 验收中追加草稿 CRUD、服务进程重启与持久化验证。

实现参考：[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[node-postgres 事务](https://node-postgres.com/features/transactions)、[Zod 输入校验](https://zod.dev/api)。
