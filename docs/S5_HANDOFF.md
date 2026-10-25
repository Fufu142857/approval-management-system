# S5 接棒资料：已有固定业务基线

本文只清点已经存在的能力、约束与验证，不提供自定义模块实现方案、代码或伪代码。S4t完成后，AI停止整个项目代码修改；用户独立完成自定义流程及相关迁移、测试、Web和小程序动态页面，提交后明确要求恢复，才可开展后续允许的工作。

## 精确基线与历史

**冻结代码基线：`d54dbe31d29f1b0edf294054330358b3479bce57`（feat: add fixed business statistics web page）。** 此前父提交为 `38e608515d09ded1978cc51f3b976ef771954374`（S4s）。阶段分支 `stage/s04t-statistics-web`，远程为 `https://github.com/Fufu142857/approval-management-system.git`。保留此前全部阶段历史；S4t代码提交后仅追加文字交接提交，不重写代码提交来填入自身哈希。2026-10-25已原子推送main与阶段分支，git ls-remote核对二者均为上述完整基线；本交接文档在后续独立docs提交中追加，代码树保持基线不变。当前远程分支可能指向后续文字提交，基线仍固定为上面的哈希。

## 运行、数据和测试

工程根是 `B_S/approval-management-system`。Node至少22.13，建议24 LTS；pnpm11.16.0，Next16.4.0/React19.3.0，全部版本以package.json与锁文件为准。遵照用户决定不升级依赖。新机器先 `pnpm install --frozen-lockfile`，私下配置 `.env`（参考 `.env.example`，不提交密码），连接PostgreSQL17，再 `pnpm db:migrate`。仅新空环境使用 `pnpm db:seed` 初始化；已有开发库不要重置、重复填测试数据或覆盖.env。

本机原生数据库在 `tmp/pgdata`、127.0.0.1:55432；开发库 `approval`，测试库 `approval_test`。启动/备份/迁移说明在 [DATABASE.md](DATABASE.md)。开发时 `pnpm dev`，生产检查 `pnpm build` 后 `pnpm start`。APP_ORIGIN须和实际地址一致；开发HTTP的Cookie配置不能照搬公开HTTPS。私有附件默认 `uploads/attachments`，也可由ATTACHMENT_STORAGE_DIR配置；数据库和附件必须配对备份/恢复。`.env`、数据库、附件、tmp截图不随Git迁移；外层两份PDF由用户私下携带。

串行验证：`pnpm test` → `pnpm build` → `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` → `pnpm test:http`。另执行 `pnpm lint`、`pnpm typecheck`、`pnpm format:check`。三类集成测试会TRUNCATE CASCADE，仅允许TEST_DATABASE_URL名称以 `_test` 结尾及隔离附件目录，严禁指向approval或交付数据；不能并行共享测试库。HTTP脚本在3100启停生产Web，浏览器在3101，均自动关闭。构建曾出现现有Next升级提醒，按提示重试同命令可完成，不等于安全告警已修复。

开发账号：初始admin密码只从本机.env的ADMIN_INITIAL_PASSWORD取得，初始只有employee/system_admin，不能默认审批。其他开发账号没有在本文声称固定存在。人工基础验收可通过注册和管理页确认独立申请人、同部门唯一有效department_head、全组织唯一有效finance_approver及company_head；审批人不能是申请人。测试账号只由 `tests/e2e/setup.ts` 在隔离测试库创建：admin和roster_00至roster_21均在研发部，普通成员employee，roster_20兼部门负责人、roster_21兼财务、roster_19兼企业负责人。测试密码在该文件中，只用于临时测试库；完整测试会改变这些数据，不能将测试完成后的数据库当成固定演示数据。其他测试各自构建并清理夹具。

## 已有接口与函数入口

HTTP完整方法/参数/结果/错误码以 [API.md](API.md) 和 `src/app/api/**/route.ts` 为准；所有JSON成功为 `{data: ...}`，失败为 `{error:{code,message,fieldErrors?}}`，附件内容成功为二进制。分页具体范围以各schema为准，常规结果为items/total/page/pageSize。读响应no-store；Cookie写入必须同源Origin，Bearer协议可供未来小程序使用，当前没有小程序实现。

| 现有能力           | 真实入口及契约                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份/组织/管理审计 | `/api/auth/register,login,logout,me`；`/api/departments`；`/api/admin/users`、`/api/admin/roles`、`/api/admin/users/:id/access`、`/api/admin/audit-logs`；API.md首节，src/lib/identity.ts、src/server/auth.ts/admin.ts                 |
| 固定差旅           | `/api/travel-drafts`及ID/submit；`/api/travel-applications`及ID、任务decision、withdraw、resubmission；`/api/travel-tasks`；src/server/travel*.ts，WEB_TRAVEL.md/WEB_TRAVEL_APPROVAL.md/WEB_TRAVEL_RESUBMISSION.md                     |
| 固定采购           | 对应purchase前缀；报价专属附件路径见API.md；src/server/purchase*.ts，WEB_PURCHASE.md/WEB_PURCHASE_APPROVAL.md/WEB_PURCHASE_RESUBMISSION.md                                                                                             |
| 固定报销           | 对应reimbursement前缀及`/api/reimbursement-link-options`；费用行票据路径见API.md；src/server/reimbursement*.ts，REIMBURSEMENT_DRAFTS.md/REIMBURSEMENT_ACTIONS.md/REIMBURSEMENT_LISTS.md及WEB_REIMBURSEMENT系列                         |
| 本人通知           | GET `/api/notifications`、`/:id`、`/unread-count`，POST `/:id/read`；src/lib/notifications.ts、src/server/notifications.ts，WEB_NOTIFICATIONS.md                                                                                       |
| 固定统计           | GET `/api/statistics`；`getFixedBusinessStatistics(token: string \| undefined, input: StatisticsInput): Promise<FixedBusinessStatistics>`在src/server/statistics.ts；输入/结果在src/lib/statistics.ts，STATISTICS.md/WEB_STATISTICS.md |
| 工作区页面         | `/account`、`/admin/users`、`/admin/audit`；三类业务各自new/drafts/applications/tasks/tasks/handled；`/notifications`、`/statistics`；路由目录src/app/(workspace)                                                                      |

以下签名已对照源码，描述现有基础设施，不保证任何固定业务函数接受未来自定义类型：

- `src/server/db.ts`：`database(): Pool`，`transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>`，`closeDatabase(): Promise<void>`。transaction自行BEGIN/COMMIT/ROLLBACK并释放连接；不要把另一个自行开事务的业务服务当作共享同一client的事务步骤。
- `src/server/auth.ts`：`requireUser(token: string | undefined, connection: Connection = database()): Promise<UserIdentity>`，`requireAdmin(token, connection = database()): Promise<UserIdentity>`；Connection为PoolClient或Pool。requireUser允许pending用户，不能单独用作业务授权；requireAdmin仅检查active system_admin，不能代替正文/任务权限。
- `src/server/business-auth.ts`：`requireBusinessActor(token: string | undefined, client: PoolClient)`返回当前UserIdentity并保证departmentId为string。它持组织共享锁、会话共享锁并核验active和有效部门；调用者提供事务client，具体资源权限仍须由服务检查。
- `src/server/page-auth.ts`：`pageUser()`返回UserIdentity或null，`requirePageUser(admin = false)`返回有效页面用户或redirect，`requireBusinessPageUser()`返回业务用户或redirect。服务端页面鉴权不替代每个HTTP接口鉴权。
- `src/server/http.ts`：`requestToken(request: Request): string | undefined`（显式Bearer优先，无效时不回退Cookie）；`checkOrigin(request: Request, publicEndpoint = false): void`；`jsonBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = 16384): Promise<T>`；`data(value: unknown, status = 200, headers?: HeadersInit): Response`；`endpoint(work: () => Promise<Response>): Promise<Response>`。
- `src/server/errors.ts`：`new ApiError(status: number, code: string, message: string)`。400输入，401身份，403权限，404不存在或隐藏，409版本/状态冲突，413大小，415媒体，500内部错误；不得输出SQL、令牌或堆栈。前端`src/lib/api-client.ts`提供api、RequestError和会话错误恢复。
- `src/server/organization.ts`：`listDepartments(): Promise<Department[]>`仅返回active部门id/name，类型在src/lib/identity-display.ts。
- `src/server/notifications.ts`：`listNotifications(token, input: NotificationListInput)`返回items/total/page/pageSize/unreadCount；`getNotification(token, id)`返回本人NotificationItem；`unreadNotificationCount(token)`返回unreadCount；`markNotificationRead(token, id)`返回id/readAt。token均string或undefined，id为string，服务自行开事务；POST只收空对象，重复已读保留首次时间。通知读取/目标权限见API.md，不存在独立对外“发送通知”HTTP接口。
- 固定业务的submit函数（如`submitReimbursementDraft(token, id, version: number)`）和get详情函数在对应`*-submission.ts`，decision/withdraw在`*-actions.ts`，列表在`*-lists.ts`，复制在`*-resubmission.ts`。它们自行开事务，输入必须经对应src/lib schema验证，返回固定业务结构；HUMAN_HANDOFF.md后半部和各专项文档已列精确签名/返回类型。当前没有可配置通用流程引擎、动态字段渲染器或模板发布服务。

## 数据库与一致性边界

迁移已到017；S4t无迁移。`schema_migrations`存校验和，旧迁移不可原地改写。表和约束以db/migrations/001–017及DATABASE.md为准：身份组织表、applications、三类业务头/明细/报价/来源关联、attachments、approval_instances/tasks/logs和notifications已存在。013后的applications.type仍只允许travel/purchase/reimbursement；没有process_templates/process_versions/process_steps或application_field_values。预留列/状态不是已实现能力，固定服务不能直接声称支持custom。

applications本人/部门外键RESTRICT；申请编号创建即分配，允许序列空号，version用于并发控制。提交后的实例快照和日志受不可修改/删除约束保护；任务与日志属于同一实例，不可改派；已激活实际人员保留历史正文/文件权限，未来blocked及未激活即取消人员没有该权限。系统管理员/同部门身份不自动获得正文；关联已批来源和汇总统计也不扩权。重提新单的不可变来源、自外键及唯一直接后续不应改写原历史。

写事务锁顺序：组织72002 →（文件写入时存储72004）→申请；详情持申请共享锁，状态/草稿写持排他锁。组织变更持72002排他锁并撤销目标会话，等待后必须重新核验权限。状态、实际任务、日志、通知必须同事务成功或全部回滚；审批携带实际taskId和最新version，未知响应先GET核对、不自动重放。固定路径为差旅/报销“部门负责人→财务”，采购“部门负责人→企业负责人”，提交时冻结实际人员；后来换角色不替换旧节点，下一冻结人员失效则批准整体拒绝，仍可驳回或本人撤回。

金额以精确十进制字符串/NUMERIC或整数分处理，不用JS浮点；采购按行half-up再合计；统计的多单批准金额不收窄回单据上限、不同类型不混加、未知不当零。列表创建/任务激活或完成日期与统计提交日期口径不同，均按上海日历边界。状态是当前状态，统计不是历史快照重建。

附件真实格式JPEG/PNG/PDF，10MiB/件、9件/申请、50MiB/申请，采购绑定报价、报销绑定费用行。仅本人草稿可改，提交冻结；元数据与私有对象文件需补偿，不能放public。`src/server/attachment-validation.ts`的`validateAttachment(bytes: Buffer, filename: string, declaredType: string)`返回bytes/originalName/mimeType/sizeBytes/sha256；它不做申请权限与配额授权。存储读写/回收在attachment-storage.ts，业务附件服务分别处理同单归属和版本。`pnpm attachments:gc`须和数据库配套，持存储独占锁核引用后再回收，不直接删除未知提交结果对应文件。

## 本轮基线验证

S4t新增Chrome专项8/8；完整单元/数据库379/379（24文件）、完整Chrome85/85、生产HTTP/Web进程重启全部通过，构建、lint、typecheck、format:check及git diff --check通过。实际截图与失败后修正记录见WEB_STATISTICS.md和DEVELOPMENT_LOG.md；HTTP重启只证明Web进程重启，不冒称数据库进程或Docker验收。代码提交已推送，后续文字提交不更改src/tests/db/package/锁文件。

## 接棒检查与保留事项

1. 核对Git基线和干净状态；读取AGENTS、STATUS、API、DATABASE、CONTRIBUTING和已有专项文档。用户自行保留后续独立提交，不改写既有作者或伪造开发历史。
2. 在独立测试环境执行基线回归，确认三类固定业务、通知、统计与文件读取；不要向开发库执行测试夹具或TRUNCATE。
3. 人工模块的需求级验收清单在HUMAN_HANDOFF.md“人工验收清单”，由用户独立实现和验证。本文不指定该模块文件组织；用户新增/修改的人工模块文件、迁移、测试及动态页面都属于独立范围，恢复后AI仍不得代写或调试。
4. 中文UI、TypeScript strict、ES modules、Prettier两空格、固定输入白名单、服务层事务和参数化SQL约定见CONTRIBUTING.md。外观遵循外层Design.pdf，查看原型后验证真实浏览器；原件和截图不公开提交。
5. 未交付：自定义流程、小程序、OCR、最终Docker/公开HTTPS/真机验收；工作台/全局搜索仍未开放，资料修改、密码重置、部门增删改仍未实现。不能将S4固定业务完成称为整个作业交付。

AI的下一步仅限完成当前文字交接和Git备份，随后等待用户独立模块成果与明确恢复指令；不会趁等待修改其他项目模块。
