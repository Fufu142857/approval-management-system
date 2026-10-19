# 身份、组织与固定差旅 HTTP 接口

S2b 身份接口由 S2c Web 页面接入；S3a 提供差旅草稿，S3b 提供固定差旅提交与提交后详情。S3c 增加通过/驳回/撤回操作与已办详情权限；S3d 增加本人通知列表/详情/未读数/已读接口；S3e 增加受控差旅附件接口；S3f 已接入差旅草稿/附件/提交与只读详情页面（见 WEB_TRAVEL.md），S3g 新增本人全状态申请与待办/已办列表 API；S3h 已接入这些列表及审批/撤回页面（见 WEB_TRAVEL_APPROVAL.md）；S3i 已接入通知页面与前台轮询（见 WEB_NOTIFICATIONS.md），S3j 新增固定差旅复制重提 GET/POST（见本文末节）；尚无自定义流程接口。验收状态见 [STATUS.md](STATUS.md)，身份页面与浏览器验证见 [WEB_IDENTITY.md](WEB_IDENTITY.md)。除附件内容成功返回二进制外，其余成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "fieldErrors"? } }`；全部响应禁止缓存。

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

所有 HTTP 时间点为 ISO 8601。通知按 recipient_id/event_key 唯一，事件键为 `task:<任务UUID>:pending`。**S3d 已提供通知列表/详情/未读数/已读 API，S3i 已接入通知页面、前台轮询和详情跳转**；待办/已办列表由 S3g 提供（见后文），审批动作见下节，不把数据库枚举当作功能已完成。

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

旧待办通知作为历史保留，是否还能操作以当前任务状态为准；不会因通知存在放宽权限。未激活即取消的未来人员不接收撤回通知，也不能读取正文。通知读取/未读数/已读接口见 S3d；S3h/S3i 已接入审批与通知 UI、前台轮询。

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

- target：当前有正文访问权时为 `{ type: "travel", id, status, apiPath: "/api/travel-applications/<UUID>" }`；无权访问或无支持的已提交业务时为 null。apiPath 是鉴权 API 地址；S3i 通过 target.type/id 映射到既有差旅页面。真正读取正文仍由该 API 重新鉴权。
- task：仅原 approval.pending 通知能匹配到本人的原任务且有正文权限时，返回 `{ id, status }`，否则 null。它始终描述这条通知原本对应的任务，不自动替换为下一任务。
- 通知 kind/title 是历史事件；target.status 和 task.status 是本次查询的当前状态。撤回后旧待办通知仍存在，可能同时返回 withdrawn/cancelled；已办任务返回 approved/rejected，不能凭通知标题继续审批。客户端进入详情后必须刷新最新版本和任务，再决定可用操作。
- 拥有通知只允许读该事件，不会自动获得正文权；target/task 为 null 时也可以标记该通知已读。既有 S3c 历史权限仍适用，未激活节点没有正文权，管理员权限不自动增加正文权。

标记已读由数据库设置时间，不接受客户端时间。首次成功后重试和并发调用都返回相同首次 readAt，不重复生成事件、不影响审批/日志/申请状态；每次仍校验会话与通知所有权。未读数在之后的 GET 中查询。没有全部已读、删除、恢复未读或通知创建接口。S3i 已接入列表/详情、显式已读与申请页面跳转，Web 可见页面每 30 秒轮询；后台推送未实现。HTTP 契约保持不变，前端生命周期与限制见 WEB_NOTIFICATIONS.md。

## S3e 受控差旅附件

以下 `:id` 为申请 UUID（草稿和已提交差旅共用），`:attachmentId` 为附件 UUID。均需有效 active 会话及有效确认部门。列表/下载沿用本人或已提交申请的已激活任务人员权限；未激活未来节点、他人、管理员无额外正文权限，统一返回 404。上传/删除仅限本人 draft，非草稿返回 409 NOT_DRAFT。提交后附件冻结，终态也不能修改。

| 方法与路径                                                         | 输入                                                                   | 成功 data / 内容                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| POST /api/travel-applications/:id/attachments                      | multipart/form-data，只含一个 file 和一个十进制正整数 version 文本字段 | 201 `{ attachment: Attachment, version }`                                    |
| GET /api/travel-applications/:id/attachments                       | 无查询参数                                                             | 200 `{ items: Attachment[], totalBytes, version, status }`，创建时间/ID 升序 |
| DELETE /api/travel-applications/:id/attachments/:attachmentId      | JSON `{ version }`                                                     | 200 `{ id, deleted: true, version }`                                         |
| GET /api/travel-applications/:id/attachments/:attachmentId/content | 可选 `disposition=attachment`（默认）或 `inline`，不收其他参数         | 200 原文件二进制；失败仍为统一 JSON 错误                                     |

Attachment：`id, appId, uploaderId, originalName, mimeType, sizeBytes, sha256, createdAt`；其中 createdAt 为数据库 ISO 8601 时间，sizeBytes 为实际字节数，mimeType 为实际识别类型。存储键/物理路径不返回。列表最多 9 项，无分页。无附件时 items 为空、totalBytes 为 0；差旅附件是选填，空列表不阻止提交。

- 容量明确按二进制口径：单件最多 10 MiB（10,485,760 字节），每申请最多 9 件、累计 50 MiB（52,428,800 字节），边界允许相等；空文件拒绝。整体 multipart 正文上限为单件上限 + 64 KiB，流式计数，不信任 Content-Length。
- 原文件名 trim 后长度 1–180，禁止路径分隔符及 Unicode 控制/格式字符。仅 jpg/jpeg、png、pdf 扩展名，大小写不敏感；必须与真实签名和声明 MIME 一致。客户端未提供 MIME 或提供 application/octet-stream 时仍按内容与扩展名识别。file、version 以外字段及重复字段一律拒绝。
- 图片使用 sharp 真实解码，最多 4000 万像素；PDF 使用 pdf-lib 校验可解析结构、尾标记和至少一页，拒绝加密/不可解析文件。保留原字节，不做病毒扫描、内容净化或格式转换。4000 万像素是服务端解析保护，不是新增课程功能。
- 上传和删除附件成功都使**申请 version 加 1**。表单保存、提交、删除草稿必须使用最新版本；409 VERSION_CONFLICT 时重新读取草稿与附件列表，不盲目覆盖。上传前先验证身份与草稿权限，写事务再检查一次；客户端不可指定上传者、申请人、大小、摘要或存储位置。
- 删除草稿同时事务删除附件元数据，再回收原文件；删除失败保留文件。提交前校验所有附件文件存在、大小和 SHA-256 匹配；缺失/损坏返回 409 ATTACHMENT_UNAVAILABLE，申请维持 draft。草稿用户可删去失效附件后重新上传；已提交附件只能由运维恢复对应原件，不能用不同内容替换。
- 内容接口每次鉴权并校验文件摘要，返回实际 Content-Type、Content-Length、UTF-8 Content-Disposition（保留中文原名）、Cache-Control: no-store、X-Content-Type-Options: nosniff、CSP sandbox 与 Referrer-Policy: no-referrer。inline 仅提供浏览器预览响应；S3f 前端图片/PDF 先鉴权读取原件再本地预览；PDF 使用 PDF.js canvas，不依赖浏览器原生插件，见 WEB_TRAVEL.md。当前整件返回，不支持 Range 分片。
- Cookie 上传/删除继续要求同源 Origin；Bearer 沿用既有来源规则。Web 构造 FormData 时不要手动写 Content-Type，让浏览器生成 boundary。小程序接入仍待 S6。

新增错误：400 EMPTY_ATTACHMENT / INVALID_MULTIPART；413 ATTACHMENT_TOO_LARGE / ATTACHMENT_QUOTA_EXCEEDED / PAYLOAD_TOO_LARGE；415 UNSUPPORTED_ATTACHMENT / ATTACHMENT_TYPE_MISMATCH / INVALID_ATTACHMENT / UNSUPPORTED_MEDIA_TYPE；409 ATTACHMENT_UNAVAILABLE。文件名/UUID/版本校验沿用 400 VALIDATION_ERROR；存储或数据库内部错误返回 500 INTERNAL_ERROR，不泄露物理路径。私有目录、事务补偿与 `attachments:gc` 见 DATABASE.md。

源码：`src/lib/attachments.ts` 定义类型/限制，`src/server/attachment-handlers.ts` 处理 HTTP，`src/server/travel-attachments.ts` 负责资源授权/事务，`attachment-validation.ts` 负责格式解析，`attachment-storage.ts` 负责私有文件与回收。真实服务签名见 HUMAN_HANDOFF.md；`tests/attachments.test.ts` 为本阶段验收，HTTP 脚本验证真实 multipart、下载与重启。解析参数依据 [sharp 构造器](https://sharp.pixelplumbing.com/api-constructor/) 和 [pdf-lib PDFDocument.load](https://pdf-lib.js.org/docs/api/classes/pdfdocument#load)。

## S3g 固定差旅申请与任务列表

| 方法 | 路径                     | 范围                                           |
| ---- | ------------------------ | ---------------------------------------------- |
| GET  | /api/travel-applications | 会话用户本人的差旅申请，包含草稿和各已提交状态 |
| GET  | /api/travel-tasks        | 会话用户实际获派的当前待办或已完成决策任务     |

两接口均要求有效会话、active 账号及有效确认部门。管理员、同部门人员或持有某审批角色，不因此获得其他人的列表；审批权限跟随提交时固定的实际人员，而非当前角色匹配。申请列表不混入本人审批的他人申请；任务列表不包含本人申请。草稿列表旧接口与排序不变。

共同查询参数：

| 参数            | 默认/限制                                        | 含义                                                     |
| --------------- | ------------------------------------------------ | -------------------------------------------------------- |
| page / pageSize | 1 / 20，上限 100000 / 100，正整数                | 偏移分页                                                 |
| type            | travel，当前只允许 travel                        | 固定业务类型；采购/报销尚未实现，传入其他类型返回 400    |
| status          | all 或 draft/pending/approved/rejected/withdrawn | **申请当前状态**，在任务列表中也不是任务原决策结果       |
| keyword         | 空串，trim 后最多 200 字符                       | 标题或编号不区分大小写的字面子串，% 与 _ 不作为通配符    |
| from / to       | 可省略，YYYY-MM-DD，年份 0001–9999               | 上海日历日期闭区间；允许只传一端，反向或无效日期返回 400 |

任务列表另有 state=pending/handled，默认 pending。未知字段、重复参数、非法枚举/分页均返回 400 VALIDATION_ERROR；不能提交 applicantId/approverId/departmentId 来改变范围。未登录或失效/停用账号为 401，待确认或部门无效为 403。空列表返回 200，不泄露他人记录数量。

时间与排序口径：申请列表 from/to 筛选 createdAt，按 createdAt DESC、id ASC；待办筛选 activatedAt，按 activatedAt DESC、任务 id ASC；已办筛选 finishedAt，按 finishedAt DESC、任务 id ASC。日期按 Asia/Shanghai 转换为包含起始日零点、不包含结束日次日零点的时间区间，和数据库会话时区无关。这不是差旅行程日期或统计提交日期筛选。

返回 `{ items, total, page, pageSize }`，任务列表额外返回 state。total 是当前全部筛选条件下的条目数；超出末页仍返回真实 total 与空 items。内容、计数、申请版本和当前节点从同一 SQL 快照读取，跨分页请求仍可能因新建/审批/撤回而位移；客户端应刷新第一页，不把查询结果视为锁定的审批资格。

申请摘要字段为：`id, appNo, type, title, status, version, applicant, createdAt, updatedAt, submittedAt, currentTask`。

- applicant：`{ id, name, departmentId, departmentName }`。已提交采用不可变人员/部门名称快照；草稿按存储的申请人及部门读取当前名称，保存时仍由现有服务更新所属部门。
- currentTask：审批中为 `{ id, seqNo, name, approver: { id, name } }`，其他状态为 null。姓名来自提交快照；不返回未来节点或整份业务正文。
- 时间点为含时区 ISO 8601；草稿 submittedAt 为 null。正文和附件需调用已有受控详情接口；草稿进入草稿接口，已提交进入申请详情接口。

任务条目为：`{ id, seqNo, name, status, activatedAt, finishedAt, application: 申请摘要 }`。

- pending 仅包含任务 pending、申请 pending、已激活且此前节点均已通过的本人实际任务；未来 blocked 不出现，不能自审。finishedAt 为 null。
- handled 仅包含本人已激活且 approved/rejected 的决策任务，保留原节点结果和完成时间；application.status/currentTask 显示当前申请状态。已办通过的申请仍可能待下一人审批，或后来被撤回/驳回。
- cancelled 不计为已办，无论此前是否激活；已激活人员仍可按已有详情权限读取历史。未来未激活即取消的节点无正文权限。
- 同一人员处理两步，按两条不同任务记录计算 total；本人申请列表仍按一条申请计算。收到旧通知不能让失效待办重新出现。

GET 不写审批日志、不改变通知已读状态或申请版本。审批/撤回仍须重新读取详情并提交最新 version、实际 taskId，由既有动作接口再次鉴权和校验，不可仅根据列表中的旧状态直接认定成功。

代码入口：src/lib/travel-lists.ts 定义两个严格 schema、输入和摘要类型；src/server/travel-list-handlers.ts 处理查询参数与 HTTP 边界；src/server/travel-lists.ts 的 listTravelApplications(token, input)、listTravelTasks(token, input) 各自开启事务并验证身份，直接服务调用前须解析相应 schema。007 仅补查询索引，见 DATABASE.md。测试见 tests/travel-lists.test.ts 与生产 HTTP 脚本；S3h 已接入列表/审批 UI，后端契约不变。

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

## S3j 固定差旅复制重提

| 方法与路径                                     | 输入                                                             | 成功 data                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET /api/travel-applications/:id/resubmission  | UUID；不接受查询参数                                             | `{ sourceId, successor: null 或 { id, appNo, status, version } }`                      |
| POST /api/travel-applications/:id/resubmission | UUID；JSON 严格 `{ version }`，整数 1–2147483647；不接受查询参数 | `{ sourceId, successor: { id, appNo, status, version }, created }`；新建 201，复用 200 |

两个接口仅有效 active 会话/部门下的原申请本人可用。其他人（含历史审批人/管理员）或不存在的来源均 404；非 rejected/withdrawn 返回 409 NOT_RESUBMITTABLE。POST 原申请版本不符返回 409 VERSION_CONFLICT，即使已有后续也先校验；明细缺失返回 409 SOURCE_INCOMPLETE 并回滚主表插入。未登录/会话无效 401，身份或部门不可用 403，UUID/正文/查询非法 400，Cookie 写入仍需同源 Origin。

同一原申请只保留一个直接后续记录，重复或并发 POST 返回已有记录的当前摘要，不覆盖其字段、版本、状态或附件。未提交后续草稿删除后可重新复制；已提交后续不能删除覆盖，后续再次驳回/撤回则以它为新的来源。不是跨删除的永久幂等键；客户端不自动重放不确定写入，先 GET 核对。

新建事务复制原差旅的固定表单内容，新 ID/编号、version=1、draft、submittedAt=null，采用当前会话申请人及当前部门；不复制附件、审批任务/决定/快照/日志/通知。原数据与原版本/时间保持不变。提交仍使用既有 /travel-drafts/:id/submit 重新校验并生成新的固定流程。

TravelDraft / TravelApplication（及草稿列表）新增 `resubmissionOf: UUID | null`，仅表达来源，普通创建/替换接口拒绝同名输入，数据库禁止改写。GET 来源关系也不扩大正文权限；新旧申请分别按原有授权规则读取，客户端不得凭来源 ID 假定能读取原附件。全状态申请/任务摘要接口没有新增此字段。

实现：src/lib/travel-resubmission.ts 定义 TravelSuccessor/TravelResubmission/TravelResubmissionResult；src/server/travel-resubmission.ts 导出 getTravelResubmission(token: string | undefined, id: string)、copyTravelForResubmission(token: string | undefined, id: string, version: number)，均自行开事务，直接服务调用前须校验 UUID/version。迁移 008 和 UI 说明见 WEB_TRAVEL_RESUBMISSION.md。
