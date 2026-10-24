# 身份、组织与固定差旅 HTTP 接口

S2b 身份接口由 S2c Web 页面接入；S3a 提供差旅草稿，S3b 提供固定差旅提交与提交后详情。S3c 增加通过/驳回/撤回操作与已办详情权限；S3d 增加本人通知列表/详情/未读数/已读接口；S3e 增加受控差旅附件接口；S3f 已接入差旅草稿/附件/提交与只读详情页面（见 WEB_TRAVEL.md），S3g 新增本人全状态申请与待办/已办列表 API；S3h 已接入这些列表及审批/撤回页面（见 WEB_TRAVEL_APPROVAL.md）；S3i 已接入通知页面与前台轮询（见 WEB_NOTIFICATIONS.md），S3j 新增固定差旅复制重提 GET/POST（见本文末节）；S4a 新增固定采购草稿 CRUD，S4b 新增采购报价附件（见本文末节）；尚无自定义流程接口。验收状态见 [STATUS.md](STATUS.md)，身份页面与浏览器验证见 [WEB_IDENTITY.md](WEB_IDENTITY.md)。除附件内容成功返回二进制外，其余成功响应为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "fieldErrors"? } }`；全部响应禁止缓存。

## 会话与请求约定

- 请求正文使用 application/json，默认最大 16 KiB（采购草稿 POST/PUT 为 256 KiB）；字段以严格白名单验证，未知字段返回 400。登录使用用户名，暂不支持邮箱登录。
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

| 参数            | 默认/限制                                        | 含义                                                      |
| --------------- | ------------------------------------------------ | --------------------------------------------------------- |
| page / pageSize | 1 / 20，上限 100000 / 100，正整数                | 偏移分页                                                  |
| type            | travel，当前只允许 travel                        | 固定差旅列表；采购/报销不在此列表中，传入其他类型返回 400 |
| status          | all 或 draft/pending/approved/rejected/withdrawn | **申请当前状态**，在任务列表中也不是任务原决策结果        |
| keyword         | 空串，trim 后最多 200 字符                       | 标题或编号不区分大小写的字面子串，% 与 _ 不作为通配符     |
| from / to       | 可省略，YYYY-MM-DD，年份 0001–9999               | 上海日历日期闭区间；允许只传一端，反向或无效日期返回 400  |

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

## S4a 固定采购草稿

S4a 提供草稿 CRUD，S4b 已补采购报价附件；本节描述 S4a 的初始范围；后续采购提交、审批、重提及 Web 页面见 S4c–S4i 各节，跨类型合并列表尚未实现。保存允许不完整内容，不表示满足报价、预算和提交条件。

| 方法与路径                      | 输入                                                                 | 成功 data                                                       |
| ------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| POST /api/purchase-drafts       | 下列可编辑字段，省略即默认                                           | 201，PurchaseDraft                                              |
| GET /api/purchase-drafts        | page 1–100000（默认 1）、pageSize 1–100（默认 20）、keyword 最长 200 | 200，`{ items: PurchaseDraftSummary[], total, page, pageSize }` |
| GET /api/purchase-drafts/:id    | UUID                                                                 | 200，PurchaseDraft                                              |
| PUT /api/purchase-drafts/:id    | 完整替换可编辑字段及必传 version                                     | 200，PurchaseDraft，version 加 1                                |
| DELETE /api/purchase-drafts/:id | 严格 `{ version }`                                                   | 200，`{ id, deleted: true }`                                    |

version 是 JSON 整数 1–2147483647。仅有效 active 用户及有效部门下的本人 purchase 草稿可访问，管理员/同部门负责人无额外权限；列表不返回差旅，也不加入既有 travel 列表。不存在、他人或其他业务 ID 为 404 NOT_FOUND；本人非草稿 409 NOT_DRAFT；旧 version 为 409 VERSION_CONFLICT，编辑版本上限为 409 VERSION_LIMIT，采购主明细缺失为 409 DRAFT_INCOMPLETE。会话/身份 401/403 沿用既有约定，Cookie 写入需同源 Origin；未来非草稿不能用此接口编辑/删除。

可编辑字段（字符串 trim；未知字段严格拒绝，包括服务端生成的身份/金额/编号/时间/状态）：

| 字段                                           | 类型与限制                                    | 默认  |
| ---------------------------------------------- | --------------------------------------------- | ----- |
| title / reason                                 | 字符串，200 / 2000 字符                       | `""`  |
| expectedDate                                   | `YYYY-MM-DD`，0001–9999 年有效日历日          | null  |
| project                                        | 字符串，200 字符；部门由服务端另行确定        | `""`  |
| budgetLimit                                    | 非负十进制金额字符串，最多十二位整数/两位小数 | null  |
| selectionReason / singleSourceReason / remarks | 字符串，各 2000 字符                          | `""`  |
| singleSource                                   | boolean，明确标记单一来源                     | false |
| items                                          | 最多 100 条，顺序即显示顺序                   | `[]`  |
| quotes                                         | 最多 20 条，顺序即显示顺序                    | `[]`  |

items 每条为 `{ id?, name?, specification?, quantity?, unit?, unitPrice? }`。name/specification/unit 最长 200/500/40 字符，默认空。quantity 为正十进制字符串，最多九位整数和三位小数，默认 null；unitPrice 为正金额字符串，最多十二位整数和两位小数，默认 null。零、负数、指数记法、超出精度、JSON number 均拒绝；空缺用 null 或省略，不传空字符串。预算可为零。格式规范化为数量三位小数、金额两位小数。

quotes 每条为 `{ id?, supplierName?, quoteDate?, amount?, basis?, purchaseUrl?, isOnline?, selected? }`。supplierName 最长 200，basis 最长 2000，purchaseUrl 最长 2000 字符且非空时必须为无账号密码的 HTTP(S) URL；默认空字符串。URL 仅存储，不抓取外部资源。quoteDate 为有效日历日或 null；amount 为上述正金额字符串或 null。isOnline/selected 默认为 false；同一草稿最多一家 selected=true，允许尚未选择。草稿可以只填一家报价、未填选择理由、单一来源说明或线上截图；这些提交前业务要求留给采购提交阶段，不静默视为合规。

服务端为新 item/quote 生成 UUID。POST 中不能指定行 ID；PUT 只允许沿用本草稿同类行的 ID（稳定保留），新行省略 ID，省略的旧行删除（S4b 起含附件报价会拒绝删除，需先显式删附件），数组重排只改变顺序。重复 ID 或外来/不存在/跨类别 ID 拒绝为 400（INVALID_ROW_ID 或 VALIDATION_ERROR），整个事务回滚。PUT 不是 PATCH，省略顶层字段会清空/恢复默认，省略数组会删除全部对应行；编辑时应仅提交上述可编辑字段，不能把带 amount 的返回 item 原样回传。

PurchaseDraft 返回可编辑字段和 `id/appNo/applicantId/departmentId/type="purchase"/status="draft"/version/createdAt/updatedAt/submittedAt=null/totalAmount`。items 另含服务端 `id/amount`，quotes 含服务端 id；不暴露 position，按数组顺序表示。列表摘要只含 `id/appNo/title/type/status/version/createdAt/updatedAt/budgetLimit/totalAmount/singleSource`，无整单明细。按 updatedAt 降序、id 升序，keyword 为标题/编号大小写不敏感字面子串（%/_ 非通配符）；计数、摘要和金额同一 SQL 快照，越界仍返回真实 total。列表时间点可能用带时区格式，语义均为 ISO 8601 时间点。

金额口径：数量按千分位、单价按分进行整数计算，单行乘积四舍五入到分（half-up），总额为各行舍入后金额之和。数据库用 NUMERIC 与 round 校验同一口径，不由客户端传入计算结果。零行或任一行数量/单价缺失时 totalAmount=null，避免把不完整采购显示为有效总价；单行不完整时 amount=null。数量与单价均为正但乘积不足半分可得 0.00，草稿允许保留，提交时仍须进行完整性/有效金额校验。单行与已填行累计金额都不得超过 999999999999.99。未持久化冗余总额，读取时从明细计算；返回 null 不等于零。

新草稿即分配全局 APP-编号，删除/回滚可空号；创建/保存使用会话用户当前部门，客户端不能指定。明细、报价、主表、版本同一事务；读取详情先锁申请 FOR SHARE，写入先 FOR UPDATE，避免读取混合版本。草稿不生成任务、日志或通知。POST 不是幂等创建，结果不确定时查询列表核对，不自动重放；PUT/DELETE 旧版本不得自动换新版本重试。

采购 POST/PUT JSON 上限 256 KiB，其他 JSON（包括采购 DELETE）仍为 16 KiB；超限 413 PAYLOAD_TOO_LARGE，不因行数上限而保证每条都能同时填满最长文本。非 JSON 为 415；非法 JSON/字段/UUID/查询为 400。仅列表接受上述查询参数，其余采购草稿接口不接受任何查询；重复查询参数拒绝。正文带 attachmentId/截图引用也会拒绝，附件通过 S4b 的独立报价附件接口管理。

实现入口：src/lib/purchase.ts 的 purchaseDraftSchema / replacePurchaseDraftSchema / purchaseDraftListSchema、PurchaseDraftInput / ReplacePurchaseDraftInput / PurchaseDraft / PurchaseDraftSummary；src/server/purchase.ts 的 createPurchaseDraft(token, input)、getPurchaseDraft(token, id)、listPurchaseDrafts(token, input)、replacePurchaseDraft(token, id, input)、deletePurchaseDraft(token, id, version)，各自开事务。token 为 string | undefined，id 为 UUID string，version 为 number；调用服务前必须通过对应 schema/UUID 验证（尤其金额先规范化）。HTTP 边界在 purchase-handlers.ts；009 迁移详见 DATABASE.md。

## S4b 固定采购报价附件

本节接口只服务本人采购草稿；S4c 提交及提交后读取见下一节，S4d 审批动作见后文，采购页面尚未实现。不能把已存在附件当作已满足线上截图或报价完整性校验。先创建草稿并保存报价取得 quoteId，再上传。附件必须属于一条报价，不接受无报价的采购附件。

| 方法与路径                                                     | 输入                                                                    | 成功 data / 内容                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| POST /api/purchase-drafts/:id/quotes/:quoteId/attachments      | multipart/form-data，恰好一个 file 与一个 version（十进制正整数字符串） | 201，`{ attachment: PurchaseAttachment, version }`                           |
| GET /api/purchase-drafts/:id/attachments                       | 不接受查询参数                                                          | 200，`{ items: PurchaseAttachment[], totalBytes, version, status: "draft" }` |
| DELETE /api/purchase-drafts/:id/attachments/:attachmentId      | JSON 严格 `{ version }`                                                 | 200，`{ id: attachmentId, deleted: true, version }`                          |
| GET /api/purchase-drafts/:id/attachments/:attachmentId/content | disposition=inline 或 attachment，默认 attachment                       | 200，鉴权后的原文件字节                                                      |

id、quoteId、attachmentId 均为 UUID。只有内容接口接受 disposition，其他附件路由不接受查询，未知/重复参数返回 400。上传体不接受 quoteId/appId/uploaderId 等额外字段；报价从路径指定并检查同一申请归属，上传人取会话用户。内容接口独立检查当前身份和草稿权限，URL 不是公开访问令牌。

PurchaseAttachment 是现有 Attachment 元数据另加 `quoteId: string`：`id/appId/quoteId/uploaderId/originalName/mimeType/sizeBytes/sha256/createdAt`，不返回 storageKey/服务器路径。列表包含整张采购申请所有报价的附件，按 createdAt/id 排序；totalBytes 和 9 件/50 MiB 限额均按整张申请累计，不是每家供应商各一份限额。

复用 S3e 的真实 JPEG/PNG/PDF 格式解析、扩展名/MIME 匹配、文件名限制、10 MiB 单件和 4000 万像素图片上限。multipart 总体上限为 10 MiB + 64 KiB，以读取字节计数为准，Content-Length 只做提前拒绝；读取上传正文前先鉴权并核报价归属，写事务内再次验证。文件存在私有 uploads/attachments（或 ATTACHMENT_STORAGE_DIR）中；预览/下载为 no-store、nosniff、sandbox CSP 与 UTF-8 安全文件名，保留原字节。只保存链接，不抓取电商资源，不把 PDF/图片文件存在当作真实报价内容已经审阅。

每次成功上传/删除都只递增申请 version 并更新 updatedAt；不保存文字、改变报价 ID/金额/选择或发通知。旧版本 409 VERSION_CONFLICT，版本上限 409 VERSION_LIMIT；不得自动换版本或重放不确定写请求。查询列表及草稿核对后再由用户明确操作。文件缺失/摘要不符为 409 ATTACHMENT_UNAVAILABLE，列表元数据仍保留。空文件 400 EMPTY_ATTACHMENT；超单件/总限额/请求大小分别为 413 ATTACHMENT_TOO_LARGE / ATTACHMENT_QUOTA_EXCEEDED / PAYLOAD_TOO_LARGE；伪装/损坏/不支持格式为 415，沿用 S3e 错误码。

未登录/失效会话 401，待确认/无效部门 403；不存在、他人、其他业务申请、跨单报价/附件为 404 NOT_FOUND。管理员/同部门负责人/财务没有草稿正文或文件特权。本人非草稿一律 409 NOT_DRAFT（包括列表和下载）；S4c 已另行提供 /api/purchase-applications 下的提交后读取，不能用草稿路径读取已提交正文或文件。

**对 S4a 草稿编辑/删除的变化：** PUT 保留原 quoteId 时，报价改名/换序/改值不改变附件归属；若省略或删除有附件的报价，整单保存 409 QUOTE_HAS_ATTACHMENTS，所有表/版本保持不变。先通过附件 DELETE 显式删除文件，再使用最新 version 保存报价删除。删除整张草稿则在一个事务里按附件元数据 → 报价 → 明细 → 采购主表 → 申请删除，提交后回收无引用文件；失败回滚时不丢文件。报价 FK 为限制删除，不自动级联丢证据。

文件写入/删除和整单删除按组织/身份/部门 → 存储共享锁 72004 → 申请行锁执行。PUT 不改文件，不需要存储锁，仍持申请行锁阻止与上传交错；读取持申请共享锁直至原字节读取完成。回收持 72004 排他锁后核全部 attachments 持久引用，不直接 unlink 不确定提交结果的文件。异常回收失败可运行 pnpm attachments:gc，必须配对当前数据库和私有目录，不能只迁移 Git。

实现：src/server/purchase-attachments.ts 导出 authorizePurchaseAttachmentUpload(token, id, quoteId)、uploadPurchaseAttachment(token, id, quoteId, version, bytes: Buffer, filename, declaredType)、listPurchaseAttachments(token, id)、deletePurchaseAttachment(token, id, attachmentId, version)、getPurchaseAttachmentContent(token, id, attachmentId)。token: string | undefined，其余 ID/文件名/声明类型为 string，version: number；各自开事务，直接调用前验证 UUID/version。upload 返回 attachment/version，list 返回整单附件摘要，delete 返回删除结果，content 返回 `{ attachment, bytes }`，无存储键。类型在 src/lib/purchase-attachments.ts；purchase-attachment-handlers.ts 处理 HTTP；attachment-http.ts 复用有界 multipart 解析与内容响应头，差旅端点契约未改变。

## S4c 固定采购提交与提交后详情

| 方法与路径                                                           | 输入                                              | 成功响应                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| POST /api/purchase-drafts/:id/submit                                 | JSON 严格 `{ version }`                           | 200，`{ application, workflow, tasks, logs }`                       |
| GET /api/purchase-applications/:id                                   | 无查询参数                                        | 200，同上                                                           |
| GET /api/purchase-applications/:id/attachments                       | 无查询参数                                        | 200，`{ items: PurchaseAttachment[], totalBytes, version, status }` |
| GET /api/purchase-applications/:id/attachments/:attachmentId/content | disposition=inline 或 attachment，默认 attachment | 200，受控原文件字节                                                 |

UUID、有效身份、Origin、JSON 16 KiB 限额沿用公共约定。提交只收最新正整数 version，不接受正文替换、身份/部门/审批人、状态或金额字段；除内容 disposition 外，以上接口拒绝所有查询（含重复参数）。只允许本人 draft 提交；不存在/他人/跨类型为 404，非草稿 409 NOT_DRAFT，旧版本 409 VERSION_CONFLICT，版本上限 409 VERSION_LIMIT。读取未知资源/其他人草稿/未授权申请均为 404。申请人提交后须改用 purchase-applications 路径，原草稿 GET/PUT/DELETE 和文件读写仍返回 NOT_DRAFT。

提交读取数据库已保存内容，核验规则如下：

- 标题、原因、期望到货日期、预算上限和选择理由必填；部门取当前有效身份，项目/备注可空。至少一条完整明细（支持多条），每条名称/规格/数量/单位/单价必填，数量/单价正数、行金额 half-up 到分后大于零，再精确合计。
- 预算覆盖计算的预计总额；拟选报价有金额时也不能超过预算。不强制总额等于报价，避免把数量 × 预计单价改成供应商报价。此为固定业务的预算校验口径，不含金额分流。
- 普通比价至少两家不同供应商；名称 trim、NFKC 和转小写后检查重复。单一来源必须 singleSource=true、恰好一家报价及非空 singleSourceReason。每条已保存报价均需完整，不能静默丢弃空行。
- 每家须有名称、日期，以及金额或 basis 明细说明；同时须有 basis 依据或本报价附件。无金额报价允许用 basis 记录明细，不能将 null 当作零价格参与比较。必须选择一家供应商；selectionReason 始终必填，未选最低价据此说明。
- isOnline=true 的报价必须有 HTTP(S) 购买链接及属于该报价的 JPEG/PNG 附件；其他报价的图片或 PDF 不能替代。仅核对格式/关联和完整性，不识别图片是否真实截图，不抓取链接或实时价格。
- 核整单附件关联/9 件与 50 MiB 配额，并逐一读取所有报价附件（含未选报价），校验大小及 SHA-256。字段问题返回 400 VALIDATION_ERROR 与 fieldErrors；关联/配额不一致 409 ATTACHMENT_INCONSISTENT，缺失/损坏文件 409 ATTACHMENT_UNAVAILABLE。失败时所有记录及版本不变。

用户在 S4c 明确选择固定路径“本部门唯一有效负责人 → 全组织唯一有效企业负责人”（role_code 分别 department_head、company_head），ruleVersion 为 fixed-purchase-v1；不按金额分支。两级各须恰好一名 active 且部门有效的人员，缺失/多名 409 APPROVER_UNRESOLVED；任一步是申请人本人 409 SELF_APPROVAL。不任意挑人或跳步，同一非申请人可承担两步。原差旅 fixed-travel-v1 的第二步仍是财务，不受此改变影响。

提交在组织/身份/部门锁后持申请 FOR UPDATE，单事务更新 pending、当前部门、version+1 和提交时间，写不可变实例/路径及实际人员快照、两个任务（部门 pending 且已激活、企业 blocked）、submitted 日志和首节点 approval.pending 通知。重复/竞争提交只有一次成功；任何写入失败整体回滚。编号沿用草稿编号。

返回 application 是完整采购字段及稳定明细/报价 ID、数据库精确金额、状态/版本和 ISO 时间；submittedAt 非空。workflow 含 id/ruleVersion/submittedVersion/routeSnapshot/createdAt。快照包括申请人/部门及两个实际审批人的 ID/姓名/部门、固定规则、budgetLimit/totalAmount、选择理由/单一来源标记及原因、selectedQuoteId/selectedQuoteAmount、priceComparisonComplete、lowestQuoteAmount、selectedNotLowest，以及 attachmentEvidence（id/quoteId/mimeType/sizeBytes/sha256，不含 storageKey）。任何报价缺少金额时 priceComparisonComplete=false，lowestQuoteAmount 与 selectedNotLowest 为 null；价格齐全时按精确分比较，包括同价并列。完整报价及明细保留在提交后冻结的业务表中。

tasks 按 seqNo 排序，包含 id/seqNo/name/approverId/status/createdAt/activatedAt/finishedAt；logs 按 createdAt/id 排序，包含 id/taskId/actorId/action/opinion/result/applicationVersion/createdAt。HTTP 时间为 ISO 字符串。实例/日志不可改删；采购请求、明细、报价及附件在非草稿时由已有触发器冻结。

提交后正文/附件授权一致：当前有效申请人或曾激活任务的实际人员可读；未激活的企业负责人、其他同角色人员、财务和管理员均无额外权限。先锁申请 FOR SHARE，再用新语句检查授权，直到正文/任务/日志/文件字节读取完成；以后状态写操作须沿用相同申请行锁。提交后文件仅可读，无新增上传/删除路径。

通知继续使用既有本人通知接口，采购待办事件 target.type=purchase，apiPath=/api/purchase-applications/:id，task 为当前实际任务状态；目标仍独立按正文权限校验。S4g 通知页面已为受控 travel/purchase 目标展示对应详情链接，不将 apiPath 当页面地址；目标不可访问或当前读取失败时隐藏跳转，进入正文/文件继续独立鉴权。

实现入口：purchase-submission.ts 的 submitPurchaseDraft(token, id, version) / getPurchaseApplication(token, id) 自行开事务；参数类型分别 string | undefined、string、number。purchase-attachments.ts 新增 listSubmittedPurchaseAttachments(token, id) / getSubmittedPurchaseAttachmentContent(token, id, attachmentId)，自行开事务。直接调用前校验 UUID/version。purchase-access.ts 的 lockSubmittedPurchase(client, id, actorId) 只可用于已完成 requireBusinessActor 的事务；readPurchaseDetail(client, id) 不自行鉴权，调用方必须先授权并持申请锁。PurchaseRecord 位于 src/lib/purchase.ts；固定提交校验位于 purchase-submission-validation.ts。S4d 已补采购审批/撤回（见下节）；S4e 列表见后文；S4f/S4g 已接入采购草稿/附件/提交/只读详情，S4h 已补审批/列表页面，S4i 重提接口见本文末节，不包含自定义模板解释。

## S4d 固定采购通过、驳回与撤回

| 方法与路径                                                 | 严格 JSON 输入                                           | 成功 data                                          |
| ---------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| POST /api/purchase-applications/:id/tasks/:taskId/decision | `{ version, decision: "approve" 或 "reject", opinion? }` | 200，最新 `{ application, workflow, tasks, logs }` |
| POST /api/purchase-applications/:id/withdraw               | `{ version, opinion? }`                                  | 200，同上                                          |

id/taskId 为 UUID，version 为最新正整数；opinion trim 后最多 2000 字符，缺省为空。reject 时意见必填且不能全空白，通过/撤回意见可空。拒绝其他 JSON 字段和所有查询参数（包括重复参数），JSON 正文上限 16 KiB，Origin/Cookie/Bearer 与公共身份协议一致。返回结构沿用 S4c，文件通过现有受控附件接口另读。没有同名 GET、任意节点跳转、指定新审批人或管理员代审入口。

权限及状态规则：

- 只有本申请当前 pending 任务的实际人员可审批，任务 ID 必须属于同一实例及本人，所有前置任务必须 approved。不以当前角色代替实际任务归属；未来 blocked 节点、已办任务、他人任务不能操作。申请人本人禁止审批，管理员/财务/新任同角色人员无额外权力。采购和差旅动作按 type 隔离。
- 仅本人 pending 申请可撤回，可在部门或企业节点执行；取消全部 pending/blocked 任务，保留已办任务及原历史，不回到 draft。
- 部门通过后关闭本任务、激活原快照企业负责人任务，申请仍 pending；企业负责人通过后申请 approved。任一步驳回则申请 rejected、取消后续未办节点，不再推进。所有成功动作仅递增一次申请 version，更新 updatedAt；编号、提交时间、明细/报价、附件、人员快照保持不变。
- 下一快照人员须 active 且当前所属部门有效，并不得为申请人；否则本次 approve 返回 409 APPROVER_UNAVAILABLE 且完整回滚，不跳步、不换成新任负责人。角色变更不影响已冻结任务归属；旧人员恢复有效账号后可继续。驳回/本人撤回不依赖下一人员是否可用。
- approved/rejected/withdrawn 为终态，不能再次审批或撤回。S4i 已补采购专用复制重提（见本文末节），不得调用差旅重提接口或改原记录为草稿。

事务先 requireBusinessActor（组织/会话/有效部门锁），再锁 purchase 申请 FOR UPDATE，检查归属/状态/版本、读取冻结任务；同一事务修改任务/申请、追加日志与通知。先关闭当前任务再激活下一节点，保持同实例最多一个 pending。每条日志记录 taskId、实际 actorId、approved/rejected/withdrawn 动作、意见、结果状态和新 applicationVersion，时间由数据库产生；实例及历史日志不更新/删除。

通知规则：部门通过通知下一实际企业负责人（approval.pending）；最终通过或驳回通知申请人（application.approved/rejected）；撤回通知本人及所有曾激活任务的实际人员，按人去重，不通知从未激活的未来节点。事件键与接收人的唯一约束防止重复。旧待办通知标题保持原事件，target.status/task.status 则返回最新状态，不可据旧通知重复审批。

正文/附件历史权限仍按 S4c：有效申请人和曾激活过任务的实际人员可读，包括被撤回的当前节点；未激活即取消的节点没有权限。详情与附件持申请共享锁；并发读须等动作事务提交后重新检查授权，避免一半新状态一半旧日志或提前授权。提交后的附件与报价仍不可更改。

错误：400 VALIDATION_ERROR（含驳回空理由/非法 ID/版本/字段/查询）、401 未登录/失效、403 账号/部门无效或 SELF_APPROVAL；404 NOT_FOUND 隐藏他人申请、陌生/跨单任务和跨类型资源；409 STATE_CHANGED（草稿/终态或状态异常）、VERSION_CONFLICT（旧版本）、VERSION_LIMIT（上限）、TASK_NOT_PENDING（不是当前有效任务）、APPROVER_UNAVAILABLE（下一人员不可用）。413 请求过大、415 非 JSON；未预期数据库异常为 500，事务全部回滚。不同授权/状态检查可能先返回其中之一，不保证所有错误同时报告。

重复请求、相反审批、审批与撤回竞争只有一个合法版本变更成功；同人负责两步也必须使用第二步 taskId 和新 version。409 或不确定网络结果后先 GET 最新详情/通知核对，不能自动刷新版本重放 POST；历史来源不自动授予新申请权限。

实现：src/lib/purchase-actions.ts 导出 purchaseDecisionSchema / purchaseWithdrawalSchema、PurchaseDecisionInput / PurchaseWithdrawalInput。src/server/purchase-actions.ts 导出 decidePurchaseTask(token: string | undefined, id: string, taskId: string, input: PurchaseDecisionInput) 与 withdrawPurchaseApplication(token, id, input: PurchaseWithdrawalInput)，各自开事务返回 S4c 详情。直接调用前需通过对应 schema 和 UUID 校验。HTTP 边界在 purchase-action-handlers.ts；只执行固定采购已冻结的任务，不解释自定义模板/字段/发布规则。无新迁移，现有 010 数据库可用。

## S4e 固定采购本人申请、待办与已办列表

| 方法与路径                     | 范围                                                           | 返回 data                                                        |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| GET /api/purchase-applications | 当前用户本人采购，含 draft/pending/approved/rejected/withdrawn | `{ items: PurchaseApplicationSummary[], total, page, pageSize }` |
| GET /api/purchase-tasks        | 当前实际待办；state=handled 时为本人已通过/驳回任务            | `{ items: PurchaseTaskSummary[], total, page, pageSize, state }` |

两接口共用可选查询：page（默认 1，1–100000）、pageSize（默认 20，1–100）、type（仅 purchase，默认 purchase）、status（默认 all 或上述申请状态）、keyword（trim 后最多 200 字符，默认空）、from/to（有效 YYYY-MM-DD，0001–9999 年，可只传一端，from 不得晚于 to）。任务接口另收 state=pending（默认）或 handled；申请接口不接受 state。未知/重复参数、非法页码/日期/type/status/state 或申请人/部门/角色等身份注入均为 400 VALIDATION_ERROR；不接受 type=all/travel。

keyword 对标题或编号做不区分大小写的字面量包含匹配，%/_ 不是通配符。from/to 按上海日历日包含首尾：本人申请筛选 createdAt，pending 任务筛选 activatedAt，handled 筛选 finishedAt；不因修改草稿 updatedAt 改变创建日筛选。排序对应时间倒序，再按申请 ID 或任务 ID 升序，平局稳定。越界页返回空 items，total 仍为全部符合过滤条件的条目数；total 不是分页内数量，也不是业务统计金额。

申请摘要包括 id/appNo/type/title/status/version、budgetLimit/totalAmount（两位小数字符串或 null）、singleSource、applicant（id/name/departmentId/departmentName）、createdAt/updatedAt/submittedAt，以及 currentTask（当前 pending 且已激活节点的 id/seqNo/name/approver{id,name}，没有则 null）。金额沿用采购明细的数据库精确舍入合计；零条明细或任一 amount 未填返回 null，完整草稿的舍入零保留 "0.00"，不表示通过提交校验；不把预算上限或选中报价当预计总额。返回 singleSource 标记便于后续展示，具体说明、报价/附件和完整正文仍从有权限的详情读取，不在列表泄露。

任务摘要含 id/seqNo/name/status（pending/approved/rejected）、activatedAt/finishedAt、application（上述完整摘要）。pending 只含本人实际任务且申请 pending、节点已激活、所有前置已通过；blocked/cancelled 不可见。handled 只含本人作过 approved/rejected 决策的任务，取消不算已办，同一人负责两步则有两行；任务 status 是原决策，application.status 是申请当前状态，例如“部门已通过，企业后续驳回”仍为 approved 任务、rejected 申请。status 查询始终筛选后者，不是任务决策结果。

本人申请仅按申请人 ID，审批人/同部门/财务/企业负责人/管理员不自动获得其他申请的列表；任务列表按冻结的实际人员，角色变更不替换任务归属，申请人本人不列为审批人。业务身份校验仍要求有效会话、active 账号和有效部门（401/403）。差旅列表与采购列表互不混入，SQL 也固定业务 type，不能靠 query 切换权限。已提交申请人和当前审批人的展示姓名取不可变快照；草稿展示保存的申请人/部门当前名称。未来 blocked 人员不单独暴露。

每次列表由单条 SQL 同时读取总数、分页项、金额/版本及当前节点，防止并发草稿保存/审批造成半新半旧摘要；只读查询不修改业务、审批、通知或已读状态。不同请求间可变化，offset 翻页不承诺冻结整个浏览会话。列表不锁定待办、不授予额外审批或附件权限；操作前重新 GET 详情并使用当前 taskId/version，出现冲突不得自动重放。

实现：src/lib/purchase-lists.ts 导出 purchaseApplicationListSchema、purchaseTaskListSchema、purchaseStatuses，以及 PurchaseApplicationListInput、PurchaseTaskListInput、PurchaseApplicationSummary、PurchaseTaskSummary、PurchaseList<T>。src/server/purchase-lists.ts 的 listPurchaseApplications(token: string | undefined, input: PurchaseApplicationListInput) 与 listPurchaseTasks(token, input: PurchaseTaskListInput) 各自开事务并检查身份，直接调用前需 schema 校验。HTTP 边界在 purchase-list-handlers.ts。011 只新增采购本人创建时间索引；共用现有任务索引。S4e 无采购页面或统计 API；草稿专用 /api/purchase-drafts 继续按更新时间排序，与此全状态列表用途不同。

## S4g Web 接入说明

HTTP 方法、正文、状态码及响应不变，无新迁移。固定字段校验从服务端提取至 src/lib/purchase-submission.ts 的 purchaseSubmissionIssues，Web 和事务内提交均先通过 purchaseDraftSchema 规范化再调用；服务端保留实际数据/附件查询、原文件完整性、配额/关联及审批人检查。前端本地校验不授予提交权限。保存与提交是两个请求，分别使用各自最新 version，保存成功不等于提交成功；超时/丢失响应先读真实状态，不自动重放。具体页面和边界见 WEB_PURCHASE.md。

## S4h Web 列表与审批接入

HTTP 契约及数据库迁移不变。/purchase/applications、/purchase/tasks、/purchase/tasks/handled 分别调用既有采购本人/待办/已办接口；URL 与金额/状态语义保持上述规则，类型切换进入对应独立业务页面。/purchase/applications/:id 现可按当前实际身份执行既有 decision/withdraw；客户端只提交 version、decision/opinion 及路径 taskId，不提交审批人。确认取消不写入；409/404 或不确定结果停写重读，不重放。完整入口、刷新/意见保留与权限说明见 WEB_PURCHASE_APPROVAL.md。S4i 另行新增采购复制重提，见下节。

## S4i 固定采购复制重提

| 方法与路径                                       | 输入                                                             | 成功响应                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET /api/purchase-applications/:id/resubmission  | UUID；不接受任何查询参数                                         | `{ sourceId, successor: null 或 { id, appNo, status, version } }`                      |
| POST /api/purchase-applications/:id/resubmission | UUID；严格 JSON `{ version }`，整数 1–2147483647；不接受查询参数 | `{ sourceId, successor: { id, appNo, status, version }, created }`；新建 201、复用 200 |

有效业务身份且仅来源本人可调用；其他员工、历史审批人、管理员、跨类型或不存在的来源均 404；账号/部门失效 403，未登录/失效会话 401。只有 rejected/withdrawn 来源可重提，其余状态 409 NOT_RESUBMITTABLE；POST 先核原 version，不匹配 409 VERSION_CONFLICT，即使已有后续也不能绕过。JSON 不接收身份、正文、来源或原报价 ID，沿用 Cookie Origin/Bearer 和 16 KiB 限额。来源明细缺失拒绝并回滚，409 SOURCE_INCOMPLETE。

POST 事务锁原申请后核已有唯一直接后续：存在时返回其当前摘要，不覆盖用户修改或已提交状态；否则创建新 ID/编号、draft、version=1、submittedAt=null，使用当前申请人/部门。复制标题、全部固定采购字段、明细/报价顺序、拟选标记、金额/未知值、线上链接、单一来源说明；明细/报价生成新 UUID，行金额仍由 NUMERIC 生成列精确计算。原申请、版本/时间、路径快照、任务、日志、通知和附件均不变；复制本身不生成审批或通知。

不复制附件元数据或文件，不沿用原报价 ID 绑定。新单提交仍走 /api/purchase-drafts/:id/submit，按当前规则重新验证预算、比价/单一来源、日期及线上报价的同报价 JPEG/PNG 截图，并重新解析固定“部门负责人 → 企业负责人”。编辑重提草稿使用既有 PUT，保留新草稿自己的行 ID。

同源并发复用一个后续；删除未提交的后续后可重新复制，已提交后续保留且再次终态时从它延长链。不是跨删除永久幂等键；客户端遇到写入失败或结果未知停写，先 GET 核对，不自动重放。查询到后续不是对其未来状态的承诺，进入正文/修改/提交仍重新授权和核版本。

PurchaseDraft / PurchaseRecord 详情新增 `resubmissionOf: UUID | null`；草稿列表/全状态列表/任务摘要未新增该字段。普通 POST/PUT 严格拒绝同名输入，012 迁移扩展既有不可变关联约束，仅允许同类型 travel/purchase、同本人、来源终态的新草稿。关联不传递正文/附件权限；界面只向本人显示原申请链接，审批人按各单实际任务单独授权。

类型在 src/lib/purchase-resubmission.ts：PurchaseSuccessor、PurchaseResubmission、PurchaseResubmissionResult。服务 src/server/purchase-resubmission.ts 导出 getPurchaseResubmission(token: string | undefined, id: string) 与 copyPurchaseForResubmission(token: string | undefined, id: string, version: number)，各自开事务；直接调用前校验 UUID/version。界面和恢复约定见 WEB_PURCHASE_RESUBMISSION.md。

## S4j 固定报销草稿与关联候选

| 方法与路径                           | 输入                                               | 成功响应                                      |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| POST /api/reimbursement-drafts       | 严格草稿 JSON                                      | 201；ReimbursementDraft                       |
| GET /api/reimbursement-drafts        | page、pageSize、keyword                            | 200；items/total/page/pageSize                |
| GET /api/reimbursement-drafts/:id    | UUID，无查询参数                                   | 200；本人 ReimbursementDraft                  |
| PUT /api/reimbursement-drafts/:id    | 严格完整替换 JSON 与 version                       | 200；version+1 的 ReimbursementDraft          |
| DELETE /api/reimbursement-drafts/:id | 严格 `{ version }`                                 | 200；`{ id, deleted: true }`                  |
| GET /api/reimbursement-link-options  | page、pageSize、keyword、可选 type=travel/purchase | 200；本人已批准候选 items/total/page/pageSize |

仅 active 业务身份和有效部门；草稿所有权由会话决定，管理员/负责人/财务没有额外权限。跨人/跨类型/不存在草稿 404 NOT_FOUND，非草稿 409 NOT_DRAFT；版本不匹配 409 VERSION_CONFLICT，PUT 版本达到 2147483647 则 409 VERSION_LIMIT，仍可按当前版本删除。鉴权、Origin、JSON 和 no-store 约定不变；POST/PUT 最多 256 KiB，其余 JSON 默认 16 KiB；未知/重复查询、非法 UUID、未允许输入字段返回 400。

草稿输入：title（≤200）、description/independentReason/remarks（各≤2000），默认空字符串；linkedApplicationIds（UUID 数组，最多20个，不重复，默认[]）；items（最多100条，默认[]）。每行有可选 id、新行省略；category 为 transport/lodging/meals/office/other 或 null，expenseDate 为 YYYY-MM-DD 或 null，purpose≤2000，amount 为正十进制字符串或 null，noReceipt 默认false，noReceiptReason≤2000 默认空。字符串去两端空白，金额不接受数字/负数/零/科学计数或超过两位小数，规范化为两位小数；日期限定有效公历 0001–9999 年。

已填每行金额与合计不超过 999999999999.99，校验使用整数分，数据库 NUMERIC(14,2) 汇总。零行或任一行未填金额时 totalAmount=null，不以零代替；其余明细还未填完时只要金额均已填，合计即可显示。noReceiptCount 是明确选中无票的行数，既不是缺失票据数也不代表无票例外已通过。草稿允许空标题/类别/日期/用途、缺独立说明或无票原因；完整必填、每行票据/无票原因、审批流转由后续提交阶段校验，S4j 本身无 submit/附件接口，S4k 附件契约见下一节；S4l已补提交，见后文。

PUT 是完整替换：省略字段恢复默认，省略 items/linkedApplicationIds 会清空费用/关联（S4k 起含票据费用须先显式删文件）；保留本单行 ID 才能稳定修改和排序，新行由服务端生成 UUID。重复或跨单/未知行 ID 返回400 INVALID_ROW_ID（重复由 schema VALIDATION_ERROR）；失败时旧单整体保留。身份、部门、编号、时间、type/status/version 派生值、totalAmount、linkedApplications、resubmissionOf、票据ID等不可通过正文伪造。新建 version=1、draft、submittedAt=null、当前部门；保存刷新为当前有效部门。

关联采用独立 application_links，支持最多20个本人已批准 travel/purchase 来源，返回关联按 UUID 排序，不保留选择顺序。同一来源可关联多份报销，不实施“原单只能报销一次”或累计额度规则。不存在/非本人/非已批/非两类来源统一404 LINK_NOT_AVAILABLE，不泄露他人状态。草稿读取和写入都在锁内重新核验关联所有权与状态；关联不授予任何人读取原单或报销的额外权限。源单正文、版本、审批历史、附件均不改；取消关联或删除报销不删除原单。来源异常时读取拒绝，仍可通过完整 PUT 清除关联恢复草稿。

ReimbursementDraft 返回输入字段及服务端 id/appNo/applicantId/departmentId/type/status/version/createdAt/updatedAt/submittedAt、totalAmount、noReceiptCount、带UUID的items、linkedApplications。后者每项含 id/appNo/title/type/status=approved/submittedAt/departmentId，以及 travel（departure/destination/startDate/endDate/durationDays/budget）或 purchase（budgetLimit/totalAmount）；另一类型字段为null。只返回这些必要摘要，不包含源审批历史或附件。

草稿列表 items 仅含 id/appNo/title/type/status/version/createdAt/updatedAt/totalAmount/noReceiptCount；候选列表 items 仅含 id/appNo/title/type/status/submittedAt/departmentId。默认page=1/pageSize=20，最大100；keyword≤200，标题/编号不区分大小写的字面包含匹配。草稿按 updatedAt DESC,id 排序；候选按 submittedAt DESC,id 排序；总数和分页单 SQL 快照，超界页返回空items及真实total。候选查询不冻结选择，保存时再次核验。

类型/schema 位于 src/lib/reimbursement.ts；事务服务 src/server/reimbursement.ts 导出 createReimbursementDraft(token, input)、getReimbursementDraft(token,id)、listReimbursementDrafts(token,input)、replaceReimbursementDraft(token,id,input)、deleteReimbursementDraft(token,id,version)、listReimbursementLinkOptions(token,input)，token 为 string | undefined，id 为UUID string，输入分别为对应schema解析后的类型。lockReimbursementDraft(client,id,ownerId,write) 仅供已执行 requireBusinessActor 的事务使用。013 迁移及范围见 REIMBURSEMENT_DRAFTS.md / DATABASE.md；没有可配置字段或动态模板能力。

## S4k 固定报销票据附件

| 方法与路径                                                          | 输入                                                           | 成功响应                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| POST /api/reimbursement-drafts/:id/items/:itemId/attachments        | multipart：恰好一个 file、一个 version，可选一个 receiptNumber | 201；`{ attachment, version }`                         |
| GET /api/reimbursement-drafts/:id/attachments                       | 无查询参数                                                     | 200；`{ items, totalBytes, version, status: "draft" }` |
| GET /api/reimbursement-drafts/:id/attachments/:attachmentId/content | disposition=inline/attachment，默认 attachment                 | 200；原始文件字节                                      |
| DELETE /api/reimbursement-drafts/:id/attachments/:attachmentId      | 严格 JSON `{ version }`                                        | 200；`{ id, deleted: true, version }`                  |

路径 ID 均为 UUID；只有有效业务身份且本人报销 draft 可调用。其他人、管理员、负责人/财务、跨类型/跨单/不存在资源返回404；失效会话401、未确认或无效部门403、非草稿409 NOT_DRAFT。上传读正文前先鉴权和检查明细归属，实际写入事务中再次检查；Cookie 写入须合法 Origin，Bearer 规则与旧接口相同。未知/重复查询、表单额外或重复字段、非法版本/号码400；不接受附件ID或外部存储键来复用已有记录。

ReimbursementAttachment 为既有 Attachment 元数据加 `itemId` 和 `receiptNumber`；包含 id/appId/uploaderId/originalName/mimeType/sizeBytes/sha256/createdAt，不含私有存储键。receiptNumber 只接受字符串，去两端空白、最多100字符、拒绝控制/格式字符；省略或空白保存为 ""，不假设税务号码格式，不校验真伪。每次上传创建新票据记录，仅绑定本单一个已保存的费用明细；记录及号码不可原位改写或改绑，填错时显式删除后重新上传。号码不是唯一键，同号码/同文件的新上传不做跨单重复票据检测，不能据此声称完成增强去重。

JPEG/PNG/PDF 校验实际文件内容、声明类型和文件名；单件10 MiB、整单最多9件且总计50 MiB，跨全部费用累计。multipart 总正文额外允许64 KiB开销，有界读取；拒绝超限413或不支持格式415。内容端点每次鉴权并验证文件大小/SHA-256，缺失/损坏409 ATTACHMENT_UNAVAILABLE；响应 no-store、nosniff、受控 Content-Disposition 与 sandbox CSP。文件存储在私有目录，不通过 public 暴露。

上传/删除使用最新申请version并递增，旧版本409 VERSION_CONFLICT、达到上限409 VERSION_LIMIT；附件操作不会替代正文保存或改变金额/无票标记。PUT 草稿保留行ID可修改/重排，省略含票据明细返回409 ITEM_HAS_ATTACHMENTS并整体回滚；须先显式删该行所有票据，再以新版本保存。整单DELETE可按当前版本一次删除票据元数据、费用、关联和申请，提交后回收无引用文件；失败保留正文和原文件。

锁顺序为组织/身份/部门 → 存储72004共享锁 → 报销申请排他锁；内容/列表持申请共享锁。存储失败、元数据/版本失败整体回滚，提交结果不确定时仅按数据库持久引用回收，不盲删文件；客户端应先重新读取，不自动重放写请求。S4l已补报销提交与提交后附件授权；S4k草稿路径仍可没有票据，noReceipt=true 也不绕过上传鉴权或配额。每行票据或无票原因的完整校验由S4l提交接口执行。

## S4l 固定报销提交与提交后详情

| 方法与路径                                                                | 输入                                                | 成功响应                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| POST /api/reimbursement-drafts/:id/submit                                 | UUID；严格JSON `{ version }`，不接受查询参数        | 200；`{ application, workflow, tasks, logs }` |
| GET /api/reimbursement-applications/:id                                   | UUID，无查询参数                                    | 200；上述详情                                 |
| GET /api/reimbursement-applications/:id/attachments                       | UUID，无查询参数                                    | 200；`{ items, totalBytes, version, status }` |
| GET /api/reimbursement-applications/:id/attachments/:attachmentId/content | UUID；disposition=inline/attachment，默认attachment | 200；已鉴权原始字节                           |

提交仅有效身份的本人draft可用；他人/管理员/跨类型/不存在404，非草稿409 NOT_DRAFT，旧版本409 VERSION_CONFLICT，上限409 VERSION_LIMIT。正文最多16KiB，只收version；Cookie同源/Bearer规则不变，不接受客户端正文、身份、总额、审批人、附件ID或来源替换。必须先保存，文件操作会更新同一version，提交成功后不能继续用草稿路径写入或读取。

完整校验：title/description必填；无关联须independentReason，关联则逐一重核本人已批travel/purchase；至少一条完整费用（不强制三条），每行category/expenseDate/purpose/正amount必填，所有值重过既有schema。每行至少一份本行票据，或noReceipt=true且noReceiptReason非空；有原因但未选例外仍要求票据。明确选中无票但已有文件的行仍保留例外，不自动改标记；包括这种文件在内的全部票据均验证原件，缺失/损坏409 ATTACHMENT_UNAVAILABLE。配额/归属异常409 ATTACHMENT_INCONSISTENT；字段问题400 VALIDATION_ERROR带fieldErrors。金额按整数分重新合计并核对NUMERIC结果，不一致409 AMOUNT_INCONSISTENT；源资格变化404 LINK_NOT_AVAILABLE。

固定路径版本fixed-reimbursement-v1：本部门唯一有效负责人→全组织唯一有效财务审批人，不按金额分支。缺失/多名409 APPROVER_UNRESOLVED，自审409 SELF_APPROVAL；同一非申请人可兼任两步。部门取提交时本人当前有效部门。事务原子设置pending/version+1/submittedAt、保存不可变人员快照、首任务pending/财务blocked、提交日志和首待办通知；任何失败全部回滚。

ReimbursementRecord扩展草稿详情的status为五种状态、submittedAt为string|null。提交后仍返回固定字段/费用/精确合计/noReceiptCount；linkedApplications为提交时冻结的必要来源摘要，不查询后来源正文，也不赋予源附件/历史权限。workflow包含id/ruleVersion/submittedVersion/routeSnapshot/createdAt；routeSnapshot含policy、applicant、steps、totalAmount、independentReason、linkedApplications、noReceiptItems（id/reason）和attachmentEvidence（id/itemId/receiptNumber/mimeType/sizeBytes/sha256，无存储键）。tasks按seqNo，含id/name/approverId/status/createdAt/activatedAt/finishedAt；logs含id/taskId/actorId/action/opinion/result/applicationVersion/createdAt，按时间/id。

详情与提交后票据仅本人或activatedAt非空的实际任务人员可读，未来blocked财务、管理员、新任负责人无特权。先持申请共享锁再重验授权；不存在、draft、无权访问统一404，身份检查同旧接口。附件响应及完整性校验沿用S4k，提交后没有上传/删除端点。通知target.type新增reimbursement，apiPath指向上述详情API；S4p通知Web已给差旅/采购/报销固定详情生成链接。报销审批动作已由S4m实现，见下节；列表后端已由S4n实现，S4o/S4p已接草稿/提交详情，S4q已接列表审批UI。

服务在src/server/reimbursement-submission.ts，固定字段校验在src/lib/reimbursement-submission.ts、持久文件校验在src/server/reimbursement-submission-validation.ts，权限在reimbursement-access.ts。真实签名/锁责任见HUMAN_HANDOFF.md；无新迁移，沿用014。详情缺少实例404 NOT_FOUND，关联快照缺失409 SNAPSHOT_INCOMPLETE；不能回退为未经授权的实时源数据。

## S4m 固定报销审批动作

| 方法与路径                                                      | 严格 JSON 输入                                           | 成功响应                                      |
| --------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| POST /api/reimbursement-applications/:id/tasks/:taskId/decision | `{ version, decision: "approve" \| "reject", opinion? }` | 200；`{ application, workflow, tasks, logs }` |
| POST /api/reimbursement-applications/:id/withdraw               | `{ version, opinion? }`                                  | 200；同上                                     |

id/taskId 必须 UUID，version 为 1–2147483647 的整数；opinion 去首尾空白，最多2000字符、默认空，reject 必须非空。禁止未知 JSON 字段和全部查询参数，正文上限16 KiB，Cookie同源/Bearer与现有接口一致；客户端不得传金额、费用、例外标记、申请人或审批人。

决策只允许有效身份的当前实际 pending 节点人员，且所有前序已通过；申请人自审403 SELF_APPROVAL，无权/不存在/跨业务申请或不属于本人的任务404 NOT_FOUND。未来节点、旧任务409 TASK_NOT_PENDING；终态/非pending/异常后续状态409 STATE_CHANGED，旧版本409 VERSION_CONFLICT，版本上限409 VERSION_LIMIT。匿名或失效会话401，待确认/失效部门403，输入400 VALIDATION_ERROR，超限413，错误媒体类型415；详见公共错误约定。

approve 沿提交时固定部门→财务快照执行：首步激活原财务，末步将申请设为approved；reject 必填理由，将申请设为rejected并取消未办。下一快照人员停用、部门无效或为申请人，批准409 APPROVER_UNAVAILABLE且事务整体回滚；不重算当前角色、不改派人员，仍可驳回或本人撤回。

本人可在任一pending节点withdraw，非本人404；成功为withdrawn，取消pending/blocked任务，保留已办结果及所有历史。两接口成功均version+1并更新updatedAt，状态/任务/日志/通知原子提交；submittedAt、固定正文/金额/费用/无票原因/来源摘要、票据和workflow快照不变。动作返回的来源摘要继续取冻结证据，不按报销权限访问实时源单。

新待办通知下一实际人员，通过/驳回通知申请人，撤回通知申请人及曾激活人员并按人去重。未激活财务无撤回通知/正文/票据权限；已激活人员在有效身份下保留终态历史读取权。通知target/task展示当前状态，已读标记不受动作影响。失败或响应丢失先GET核对，不自动重放；重复操作不追加日志或通知。

类型/schema在src/lib/reimbursement-actions.ts，事务服务在src/server/reimbursement-actions.ts，HTTP边界在reimbursement-action-handlers.ts，详细锁与调用责任见HUMAN_HANDOFF.md。本阶段无新迁移，仍014；S4n已补列表，尚无报销审批页面或复制重提。

## S4n 固定报销列表

GET /api/reimbursement-applications 返回本人所有状态报销申请；GET /api/reimbursement-tasks 返回本人当前实际待办或已办。二者独立于差旅/采购接口，不扩大源单访问权。

共用严格参数：page=1..100000（默认1）、pageSize=1..100（默认20）、type仅reimbursement（默认）、status=all/draft/pending/approved/rejected/withdrawn（默认all）、keyword（trim后≤200字符、标题/编号大小写不敏感字面量匹配）、from/to（有效YYYY-MM-DD，年份0001–9999，起止有序）；任务另收state=pending/handled（默认pending）。未知、重复或非法参数400 VALIDATION_ERROR。status筛选申请当前状态；from/to按上海日历日包含首尾，申请按createdAt、待办按activatedAt、已办按finishedAt筛选和降序排列，id升序打破同时间排序。

返回data={items,total,page,pageSize}，任务另含state；空页保留筛选总数。申请摘要为{id,appNo,type,title,status,version,totalAmount,noReceiptCount,applicant:{id,name,departmentId,departmentName},createdAt,updatedAt,submittedAt,currentTask}。currentTask为当前已激活pending节点{id,seqNo,name,approver:{id,name}}或null；已提交姓名来自冻结快照。totalAmount为精确两位小数字符串，零行或缺金额为null；noReceiptCount只计显式无票标记，不代表缺文件或已通过校验。无费用行/正文/原因/来源摘要/票据/未来节点。

任务摘要为{id,seqNo,name,status,activatedAt,finishedAt,application:申请摘要}。pending只收实际当前人员且前序已通过、申请仍pending的已激活任务；handled只收本人approved/rejected，取消任务不计已办。同人两步按任务各计一条；task.status与application.status独立，例如已通过后撤回仍保留原通过结果。

匿名/过期/停用会话401，有效待确认身份或无效部门403；管理员/财务角色不扩大本人范围，角色改变不替换冻结任务人员。所有成功响应no-store；列表只读，不自动标已读。组织锁后重验身份，条目/总数/版本/金额/无票数/当前节点同一SQL快照；后续动作仍须重读并验证taskId/version。类型/服务见reimbursement-lists.ts，HTTP边界见reimbursement-list-handlers.ts，完整说明见[REIMBURSEMENT_LISTS.md](REIMBURSEMENT_LISTS.md)。新增015索引；S4o/S4p已补报销草稿/提交详情，S4q已接列表审批页面，S4r已接固定报销复制重提，统计尚未实现。

## S4o 报销草稿Web接入

本阶段未新增或改变HTTP契约。/reimbursement/new、/reimbursement/drafts、/reimbursement/drafts/:id接入S4j/S4k现有草稿、候选与票据接口；仅本人草稿可编辑，页面鉴权不替代API授权。表单PUT只带固定输入及稳定行ID，票据上传绑定已保存itemId、可选receiptNumber和最新version；文件操作不自动保存正文。细节与错误恢复见[WEB_REIMBURSEMENT.md](WEB_REIMBURSEMENT.md)。S4p/S4q已另行接入提交/提交后详情和报销列表动作UI，S4r另行接入固定报销复制重提；提交/审批/列表仍按上述S4l–S4n接口调用。

## S4p 报销提交与只读详情Web接入

无新HTTP契约或迁移。草稿页使用既有POST /api/reimbursement-drafts/:id/submit（只收version），先保存当前输入再提交；/reimbursement/applications/:id使用本节已实现详情与票据读取，正文/附件version和status必须匹配。通知固定映射加入reimbursement，不扩展正文/源单/附件权限。组件和失败恢复见WEB_REIMBURSEMENT_SUBMISSION.md。

## S4q 报销列表与审批Web接入

无新增HTTP契约或迁移。/reimbursement/applications使用本人全状态GET；/reimbursement/tasks及/handled使用固定state查询任务；详情通过已有decision/withdraw端点提交实际taskId、最新version与opinion。URL查询仅允许page/pageSize/type/status/keyword/from/to，重复/未知/非法项给重置入口。页面默认10条；金额/null与noReceiptCount原样展示，日期语义沿上述S4n契约。正文/票据version和status不一致或读取失败时无操作入口，前端角色判断不替代服务端授权。失败恢复、具体组件签名与验证见WEB_REIMBURSEMENT_APPROVAL.md。

## S4r 固定报销复制重提

GET /api/reimbursement-applications/:id/resubmission返回data={sourceId,successor}，successor为null或{id,appNo,status,version}。POST同路径只接受严格{version:number}（1–2147483647），新建201/已有后续200，返回data={sourceId,successor,created:boolean}。UUID、未知JSON字段/非整数/字符串版本、任何查询参数均严格拒绝；Cookie/Origin、身份和no-store沿既有接口。无额外参数或动态模板能力。

仅有效业务身份的本人rejected/withdrawn报销可查询或复制。无权/其他类型/不存在404 NOT_FOUND，非终态409 NOT_RESUBMITTABLE，旧版本409 VERSION_CONFLICT；已有后续也先校验原版本。复制前重验关联源均为本人approved的travel/purchase，失败404 LINK_NOT_AVAILABLE；明细不完整409 SOURCE_INCOMPLETE（缺头沿既有DRAFT_INCOMPLETE）。身份失效/禁用401、待确认或部门无效403，通用错误约定不变。

新草稿新编号/当前部门/version=1/submittedAt=null/resubmissionOf=原报销ID，复制标题、description、independentReason、remarks、费用顺序/分类/日期/用途/NUMERIC金额/noReceipt及原因，费用生成新ID；有效linkedApplicationIds复制但不授予源全文/附件权限。附件/号码/文件对象、审批实例/任务/日志/通知不复制，原记录及历史不变。后续保存/提交重新检查关联、完整费用、逐行票据或显式无票原因及当前部门/财务审批人。

同一原申请只保留一个直接后续，并发/重复返回已有后续当前状态，不覆盖用户编辑。删除未提交后续可再次创建；后续已提交则保留链，从后续终态继续。GET只查关系不创建、不标已读。复制任何失败先GET核对，不自动重试POST；原版本冲突刷新原详情。新增只读resubmissionOf:string|null出现在报销草稿和提交后详情，普通草稿写入schema不接受它；列表摘要契约不变。UI与锁顺序见WEB_REIMBURSEMENT_RESUBMISSION.md，数据库新增016迁移。
