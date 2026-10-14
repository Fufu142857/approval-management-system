# 身份与组织 HTTP 接口

S2b 实现范围；验收状态见 [STATUS.md](STATUS.md)。尚无审批、附件、通知或自定义流程接口。所有成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "fieldErrors"? } }`；全部响应禁止缓存。

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

## 错误和接入文件

400：VALIDATION_ERROR / INVALID_JSON / INVALID_DEPARTMENT；401：UNAUTHENTICATED / INVALID_CREDENTIALS；403：FORBIDDEN / INVALID_ORIGIN；404：NOT_FOUND；409：ALREADY_EXISTS / SELF_ACCESS_CHANGE；413：PAYLOAD_TOO_LARGE；415：UNSUPPORTED_MEDIA_TYPE；429：RATE_LIMITED；500：INTERNAL_ERROR。登录错误不区分用户不存在、密码错误和已禁用。500 不回传 SQL 或异常堆栈。

- `src/lib/identity.ts`：输入 schema、角色代码、UserIdentity 类型，可供 S2c 页面共享。
- `src/server/identity-handlers.ts`：HTTP 适配；`src/app/api/**/route.ts` 只导出对应处理器。
- `src/server/auth.ts`：register、login、requireUser、requireAdmin、logout；requireUser 允许 pending，不能代替业务 active 检查。
- `src/server/admin.ts`：changeUserAccess、listUsers、listAuditLogs；直接调用服务的输入必须先经过相应 schema 校验。
- `src/server/http.ts`：来源检查、正文限制、Cookie、统一错误响应。`src/server/` 仅供服务端使用，不得从 Client Component 导入。
- `tests/identity.test.ts`：真实 PostgreSQL 身份、权限、事务和并发验收；不涉及人工模块。

实现参考：[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[node-postgres 事务](https://node-postgres.com/features/transactions)、[Zod 输入校验](https://zod.dev/api)。
