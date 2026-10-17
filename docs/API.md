# 身份、组织与固定差旅 HTTP 接口

S2b 身份接口由 S2c Web 页面接入；S3a 提供差旅草稿，S3b 提供固定差旅提交与提交后详情。S3c 增加通过/驳回/撤回操作与已办详情权限；S3d 增加本人通知列表/详情/未读数/已读接口；尚无差旅页面、附件或自定义流程接口。验收状态见 [STATUS.md](STATUS.md)，身份页面与浏览器验证见 [WEB_IDENTITY.md](WEB_IDENTITY.md)。所有成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "fieldErrors"? } }`；全部响应禁止缓存。

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

## S3b 固定差旅提交与详情

| 方法与路径                         | 权限与请求                               | 成功响应                                      |
| ---------------------------------- | ---------------------------------------- | --------------------------------------------- |
| POST /api/travel-drafts/:id/submit | 本人草稿；JSON 只允许 `{ "version": 1 }` | 200，`{ application, workflow, tasks, logs }` |
| GET /api/travel-applications/:id   | 本人或该申请已激活任务的实际审批人       | 200，同上                                     |

两者都要求有效会话、active 账号和有效确认部门。管理员无正文特权，后续 blocked 节点审批人暂不能访问；不属于授权范围、没有提交或不存在均返回 404。角色调整不会改写旧实例或重新挑选审批人；旧实际审批人仍 active 且部门有效时，重新登录后可访问其已激活任务对应申请，即使任务已完成/失效或已移除该角色。未激活即被取消的后续任务不授予正文权限。停用账号不能访问；自动转派未实现。

提交先取得组织共享锁和申请行锁，检查 owner/draft/version，再从数据库读取完整字段重新校验。title、departure、destination、purpose、transportation 必须非空，startDate/endDate/budget 必填；companions/remarks 可为空。日期、长度和金额范围沿用草稿约束，零预算有效，不引入金额阈值。保存成功不等于满足提交条件，缺字段返回 400 VALIDATION_ERROR 和 fieldErrors。

固定规则 `fixed-travel-v1`：**申请人当前确认部门的唯一有效 department_head → 全组织唯一有效 finance_approver**。有效指 active 账号且所属部门 active；财务角色不限定必须归属财务部。不足一人或多于一人返回 409 APPROVER_UNRESOLVED，路径包含申请人本人返回 409 SELF_APPROVAL；不跳过、不随机选人，由管理员核验授权。同一个非申请人同时具有两种角色可承担两步，但仍是两个顺序任务。本规则是本轮采用的明确业务默认值，不是用户已确认的组织制度；后续如调整，新规则须另有版本标识，旧快照保持不变。

一次事务写入 pending 状态、version+1、提交时间和当前部门，保留原编号；保存固定规则、预算/天数、申请人/部门及两级实际审批人的名称/ID快照；创建首个 pending 和第二个 blocked 任务、一条 submitted 日志、一条给首节点审批人的持久化通知。任一步失败全部回滚，失败不留下任务或通知。实例与日志禁止更新/删除，提交后不能用草稿接口编辑或删除。

并发相同提交只有一次成功；随后重复提交返回 409 NOT_DRAFT，不重放 200，也不重复产生通知。仍为草稿但版本已变返回 409 VERSION_CONFLICT；版本达上限返回 409 VERSION_LIMIT。遇到超时或不确定结果，先 GET 提交后详情确认；若仍为草稿，再读取最新草稿版本和内容，由使用者决定是否重新提交，不盲目重试覆盖。

返回结构：

- application：草稿的固定字段及身份/编号/时间，status 提交时为 pending，后续可为 approved/rejected/withdrawn；submittedAt 非空、version 随状态流转增加；金额仍为字符串、日期仍为 YYYY-MM-DD。
- workflow：id、ruleVersion、submittedVersion、routeSnapshot、createdAt。routeSnapshot 包含 ruleVersion、policy、applicant（id/name/departmentId/departmentName）、budget、durationDays、steps；每步含 seqNo/name/rule/approver（同上四个人员字段）。仅保留固定执行快照，无模板编辑或解释 API。
- tasks：按 seqNo 升序，id/seqNo/name/approverId/status/createdAt/activatedAt/finishedAt；后两项未发生时为 null。
- logs：按 createdAt/id 升序，id/taskId/actorId/action/opinion/result/applicationVersion/createdAt；提交记录 taskId=null、action=submitted、opinion=""、result=pending。

所有 HTTP 时间点为 ISO 8601。通知按 recipient_id/event_key 唯一，事件键为 `task:<任务UUID>:pending`。**S3d 已提供通知列表/详情/未读数/已读 API，轮询和跳转界面尚未实现**；待办列表仍未提供，审批动作见下节，不把数据库枚举当作功能已完成。

## S3c 固定差旅审批与撤回

| 方法与路径                                               | 请求                                                         | 权限与结果                                            |
| -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| POST /api/travel-applications/:id/tasks/:taskId/decision | `{ "version": 2, "decision": "approve", "opinion": "同意" }` | 该申请当前 pending 任务的实际审批人；200 返回完整详情 |
| POST /api/travel-applications/:id/withdraw               | `{ "version": 2, "opinion": "行程取消" }`                    | 本人且申请 pending；200 返回完整详情                  |

两个路径 ID 均为 UUID。正文严格白名单，version 是当前申请版本，不是任务序号。decision 仅 approve/reject；opinion 去两端空白后最多 2000 字符，通过和撤回可省略/为空，驳回必须非空。Cookie 写请求仍需同源 Origin；服务端执行 active、有效部门、会话检查，禁用/撤销会话不能操作。

处理规则：

- 通过关闭当前任务；有下一节点时仅激活该节点、申请仍 pending；最后一步通过才置 approved。每次成功 version 加 1，日志记录实际任务、操作者、意见、新版本及本次结果，提交时间和原快照不变。
- 驳回将当前任务置 rejected、未完成后续任务置 cancelled，申请进入 rejected 终态；保留已办任务和历史。
- 本人可在任一 pending 阶段撤回；所有 pending/blocked 任务置 cancelled，已完成任务保留。日志关联撤回时的当前任务；申请进入 withdrawn 终态，不返回草稿。
- 任务归属来自提交快照，管理员无审批特权。申请人自审返回 403 SELF_APPROVAL；不属于自己的任务、任务与申请不匹配、非本人撤回返回 404。已完成/未激活任务不能操作，返回 409 TASK_NOT_PENDING；terminal 返回 409 STATE_CHANGED；旧版本返回 409 VERSION_CONFLICT。先检查归属，再检查状态/版本，不向无关用户泄露状态。
- 若下一快照审批人停用或部门无效，当前通过返回 409 APPROVER_UNAVAILABLE 并完整回滚。恢复原人员账号后可继续；不因角色移除而换人，不自动转派或跳过。驳回/撤回不依赖下一人员可用。
- 同一非申请人负责两步时仍须处理两个不同任务。即使用最新申请版本重放旧 taskId，也不能处理下一节点。超时/409 后读取详情，由使用者确认是否发起新的动作，不自动换版本重试。

所有写入遵循组织共享锁 → 会话/部门 → 申请排他行锁，再检查版本/当前节点。审批与撤回使用同一申请锁，相同版本并发只有一个成功；后到请求不会追加日志或通知。任务、申请、日志、通知任一写入失败全部回滚。详情先获得申请共享行锁，等待写事务完成后再查询权限和完整详情，防止返回新旧混合的任务/日志。

通知接收规则与事件键：

| 事件          | 接收人                                   | event_key                                            |
| ------------- | ---------------------------------------- | ---------------------------------------------------- |
| 下一待办      | 下一实际审批人                           | `task:<任务UUID>:pending`                            |
| 全部通过/驳回 | 申请人                                   | `application:<申请UUID>:<新版本>:approved或rejected` |
| 撤回          | 申请人及曾激活任务的实际审批人，按人去重 | `application:<申请UUID>:<新版本>:withdrawn`          |

旧待办通知作为历史保留，是否还能操作以当前任务状态为准；不会因通知存在放宽权限。未激活即取消的未来人员不接收撤回通知，也不能读取正文。通知读取/未读数/已读接口见 S3d；业务 UI 和前台轮询留待后续。

## S3d 本人站内通知

| 方法与路径                          | 请求                                   | 成功响应 data                                   |
| ----------------------------------- | -------------------------------------- | ----------------------------------------------- |
| GET /api/notifications              | page/pageSize/state?                   | `{ items, total, unreadCount, page, pageSize }` |
| GET /api/notifications/:id          | UUID，不接受查询参数                   | NotificationItem                                |
| GET /api/notifications/unread-count | 不接受查询参数                         | `{ unreadCount }`                               |
| POST /api/notifications/:id/read    | UUID，JSON 必须为 `{}`，不接受查询参数 | `{ id, readAt }`                                |

以上均需有效会话、active 账号与有效确认部门，且只操作会话用户收到的通知，不接受 recipientId/userId。管理员无查看或标记他人通知的特权；他人的通知与不存在的 ID 均返回 404 NOT_FOUND。列表查询、读取详情都不会自动标记已读；标记必须显式发 POST，Cookie 写请求需同源 Origin。无效 ID/参数/正文返回 400，未确认返回 403，失效会话返回 401。

分页默认 page=1/pageSize=20，上限分别 100000/100；state 仅 all/unread/read，默认 all。按 createdAt DESC、id DESC 稳定排序；超出末页返回空 items 与真实 total。total 是当前 state 筛选后的总数，unreadCount 始终是本人全部未读数，不受分页和 state 影响。列表的内容/总数/未读数/关联当前状态在同一 SQL 快照中产生；独立未读数接口是另一个时点，状态变化后与此前列表有差异属正常情况。跨页请求期间有新事件时，偏移分页可能位移，客户端刷新第一页即可。

NotificationItem 包含 `id, appId, kind, title, createdAt, readAt, target, task`。kind 为 approval.pending/application.approved/application.rejected/application.withdrawn；title 保留事件生成时标题，createdAt/readAt 为 ISO 8601（未读 readAt=null），不返回接收人资料或内部事件键。

- target：当前有正文访问权时为 `{ type: "travel", id, status, apiPath: "/api/travel-applications/<UUID>" }`；无权访问或无支持的已提交业务时为 null。apiPath 是已存在的鉴权 API，不是尚未实现的页面地址。真正读取正文仍由该 API 重新鉴权。
- task：仅原 approval.pending 通知能匹配到本人的原任务且有正文权限时，返回 `{ id, status }`，否则 null。它始终描述这条通知原本对应的任务，不自动替换为下一任务。
- 通知 kind/title 是历史事件；target.status 和 task.status 是本次查询的当前状态。撤回后旧待办通知仍存在，可能同时返回 withdrawn/cancelled；已办任务返回 approved/rejected，不能凭通知标题继续审批。客户端将来进入详情后必须刷新最新版本和任务，再决定可用操作。
- 拥有通知只允许读该事件，不会自动获得正文权；target/task 为 null 时也可以标记该通知已读。既有 S3c 历史权限仍适用，未激活节点没有正文权，管理员权限不自动增加正文权。

标记已读由数据库设置时间，不接受客户端时间。首次成功后重试和并发调用都返回相同首次 readAt，不重复生成事件、不影响审批/日志/申请状态；每次仍校验会话与通知所有权。未读数在之后的 GET 中查询。本轮不提供全部已读、删除、恢复未读、通知创建接口，也没有前台轮询/后台推送或页面跳转实现。

## 错误和接入文件

400：VALIDATION_ERROR / INVALID_JSON / INVALID_DEPARTMENT；401：UNAUTHENTICATED / INVALID_CREDENTIALS；403：FORBIDDEN / INVALID_ORIGIN；404：NOT_FOUND；409：ALREADY_EXISTS / SELF_ACCESS_CHANGE；413：PAYLOAD_TOO_LARGE；415：UNSUPPORTED_MEDIA_TYPE；429：RATE_LIMITED；500：INTERNAL_ERROR。登录错误不区分用户不存在、密码错误和已禁用。500 不回传 SQL 或异常堆栈。

差旅新增：403 ACCOUNT_NOT_ACTIVE / DEPARTMENT_INACTIVE；409 NOT_DRAFT / VERSION_CONFLICT / VERSION_LIMIT / APPROVER_UNRESOLVED / SELF_APPROVAL。S3c 另有 403 SELF_APPROVAL、409 STATE_CHANGED / TASK_NOT_PENDING / APPROVER_UNAVAILABLE。金额、日期、版本与白名单错误均沿用 400 VALIDATION_ERROR。已存在但不属于访问范围的申请与不存在的 ID 均为 404 NOT_FOUND。

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
- `src/server/business-auth.ts`：`requireBusinessActor(token: string | undefined, client: PoolClient)`；事务内先取组织共享锁再检查身份、锁会话和有效部门，草稿与提交复用，不能在事务外调用。
- `src/lib/travel.ts`：`completeTravelSchema` 与 `TravelApplication` 是固定差旅的完整校验/返回类型；没有动态字段配置。
- `src/server/travel-submission.ts`：`submitTravelDraft(token: string | undefined, id: string, version: number)`、`getTravelApplication(token: string | undefined, id: string)`；各自负责事务，直接调用前必须校验 UUID 与 version，提交时服务端仍校验已存表单。
- `src/server/travel-submission-handlers.ts`：HTTP 来源/正文/参数验证和统一响应；两个新路由仅导出处理器。
- `tests/travel-submission.test.ts`：15 项提交、快照、权限、竞争、回滚、不可变与去重约束测试；HTTP 脚本另验证生产路由、重复提交拒绝、详情授权，以及实际重启后申请/快照/任务/日志/通知保留。

- `src/lib/travel-actions.ts`：travelDecisionSchema / travelWithdrawalSchema，及 TravelDecisionInput / TravelWithdrawalInput。
- `src/server/travel-actions.ts`：`decideTravelTask(token: string | undefined, id: string, taskId: string, input: TravelDecisionInput)`、`withdrawTravelApplication(token: string | undefined, id: string, input: TravelWithdrawalInput)`；均自行开事务，直接调用服务前须按对应 schema 和 UUID 校验参数。
- `src/server/travel-action-handlers.ts`：新增两个 HTTP 处理器；`submittedDetail(client, id, actorId)` 在现有事务及业务身份检查后使用，负责申请共享锁、资源权限和一致详情，不负责开启事务或验证会话，不能单独暴露为绕过认证的入口。
- `tests/travel-actions.test.ts`：14 项新增验收，覆盖正常/终态、授权、固定快照、竞争、故障回滚和详情一致性；生产 HTTP 脚本覆盖三种终态及实际进程重启保留。

- `src/lib/notifications.ts`：notificationListSchema、emptyNotificationSchema、NotificationListInput / NotificationItem。
- `src/server/notifications.ts`：`listNotifications(token: string | undefined, input: NotificationListInput)`、`getNotification(token: string | undefined, id: string)`、`unreadNotificationCount(token: string | undefined)`、`markNotificationRead(token: string | undefined, id: string)`，各自事务内身份检查；直接调用前校验 UUID/输入 schema。
- `src/server/notification-handlers.ts`：四个 HTTP 处理器；`tests/notifications.test.ts` 包含 12 项通知验收，HTTP 脚本验证生产路径及阅读时间重启保留。

实现参考：[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[node-postgres 事务](https://node-postgres.com/features/transactions)、[Zod 输入校验](https://zod.dev/api)。
