# 人工模块交接边界

**当前状态：已到S5交接点，停止整个项目代码修改。** 冻结代码基线 `d54dbe31d29f1b0edf294054330358b3479bce57` 已推送并核对main/阶段分支。完整接棒资料见 [S5_HANDOFF.md](S5_HANDOFF.md)，其中包含实际签名/路径、数据库与事务边界、运行命令、测试数据和已知缺口。 当前完成 S0/S1 与 S2 身份管理（数据库、接口、Web 页面及浏览器验收）；S3a–S3e 固定差旅审批、本人通知与受控附件后端也已完成，S3f 已接入差旅草稿/附件/提交与只读详情页面；S3g 已完成固定差旅全状态及待办/已办列表后端；S3h 已接入列表与审批/撤回页面；S3i 已接入通知页面与前台轮询；S3j 已完成差旅复制重提；S4a 已完成固定采购数据模型与草稿后端；S4b 已实现采购报价附件；S4c 已完成固定采购提交与提交后详情，S4d 已完成固定采购审批动作，S4e 已完成采购申请与任务列表后端，S4f 已接入采购草稿与报价附件页面，S4g 已接入采购提交与提交后只读详情，S4h 已接入采购列表与审批操作页面，S4i 已接入采购复制重提，S4j 已完成固定报销草稿后端，S4k 已完成报销票据附件后端，S4l 已实现报销提交与提交后详情，S4m 已完成报销审批动作，S4n 已完成报销申请与任务列表后端，S4o 已接入报销草稿与票据 Web 页面，S4p 已接入报销提交、只读详情与通知跳转，S4q 已接入报销列表与审批操作页面，S4r 已接入固定报销复制重提，S4s 已实现固定业务统计后端，S4t 已接入查询统计页面与状态图。下文较早阶段描述保留当时含义；S4固定业务已完成，S5交接只补文字资料，不编写人工模块。最新进度见 STATUS.md。本文不是自定义模块实现方案，不含代码或实现伪代码。

## 独立完成范围

Assignment 第 3 页第 6 模块：“本功能模块实现不能使用AI辅助编程。”Design 第 19 页 5.3 节也作了相同承诺。

由用户亲自实现：管理员模板管理页面与 API、动态字段定义与校验/显示、节点配置与调整、审批人规则解析、发布检查、模板版本管理、自定义申请的保存和提交、此模块特有数据库迁移/种子/测试，以及 Web/微信小程序中相关动态页面。不能由 AI 先写完整通用表单生成器后交给用户填字段。

AI 可以在此前实现三类固定业务实际需要的基础认证、授权、数据库事务、附件、顺序待办执行、审批日志、通知和查询。交接只说明这些**已经存在**的公共能力及调用限制；自定义模块内部实现由用户决定。

## 当前已有公共接口

S1 提供 `GET /api/health`，实现文件 `src/app/api/health/route.ts`。无需认证，成功为 HTTP 200，响应 `{"data":{"service":"approval-management-system","status":"ok"}}`，带 `Cache-Control: no-store`。它只表示 Web 进程存活，不访问数据库，也不代表用户已登录或业务可用。验证记录见开发日志。

S2b 新增注册/登录/退出/个人资料、部门与角色字典、管理员用户分页/确认/授权/禁用及审计查询，实际路径、参数、错误码和源码入口见 [API.md](API.md)。身份类型和输入校验在 `src/lib/identity.ts`，服务端认证在 `src/server/auth.ts`，组织授权事务在 `src/server/admin.ts`。`requireUser` 允许待确认用户，不能直接作为后续业务放行条件；业务还必须检查 active 及实际资源权限。管理员不自动拥有业务审批权。

S2c 页面已接入现有身份服务，页面路由、前端组件、错误/会话约定及浏览器验收见 [WEB_IDENTITY.md](WEB_IDENTITY.md)。S2d 公共外观、共享组件及设计验收约束见 [UI_GUIDELINES.md](UI_GUIDELINES.md)；用户接棒时也可据此保持统一外观。现有身份页没有各自独立原型，不代表后续业务原型已完成。

这些组件只包含固定身份字段，不包含动态字段生成或自定义模板逻辑。

S3a 已有固定差旅草稿：`POST/GET /api/travel-drafts` 和 `GET/PUT/DELETE /api/travel-drafts/:id`。真实 schema/类型在 `src/lib/travel.ts`，事务服务在 `src/server/travel.ts`，完整契约见 API.md。仅本人 active 账号及有效部门可访问；PUT 完整替换且需要 version，DELETE 也需 version；两表事务、先组织共享锁再会话/申请锁。编号创建时分配，日期为日历日期、自然日含首尾，金额传精确字符串。

002 迁移建立 applications / travel_requests；013 已扩展为固定 travel/purchase/reimbursement 类型，不包含动态字段、流程模板、版本发布或规则解析。草稿的公共主表不是自定义模块已经可接入的承诺，固定业务已由S3–S4补齐，但不能把它当成自定义模块已可直接接入的承诺。

S3b 已有 `POST /api/travel-drafts/:id/submit`（只收 version）和 `GET /api/travel-applications/:id`。服务在 `src/server/travel-submission.ts`：`submitTravelDraft(token: string | undefined, id: string, version: number)` 与 `getTravelApplication(token: string | undefined, id: string)`，返回 application/workflow/tasks/logs。服务自行开事务，HTTP 参数校验和权限契约见 API.md；固定 v1 的两步选择只适用于差旅，不是通用配置解析器。

`src/server/business-auth.ts` 的 `requireBusinessActor(token: string | undefined, client: PoolClient)` 是草稿/提交共用的事务内身份检查，先组织 72002 共享锁，再会话/有效部门锁；不能在事务外使用。状态变更还须锁申请行，先核版本后写业务、待办、日志、通知；组织写入使用同号排他锁。

003 新增固定执行所需 approval_instances/tasks/logs/notifications，实例与日志不可更新/删除，首个任务 pending、下一步 blocked。通知按接收人和事件键去重。当前用固定版本标识与不可变 JSON 快照，不含模板配置/发布/版本表或动态字段；完整模型及真实可复用边界到 S4 再冻结。

S3c 已有 `POST /api/travel-applications/:id/tasks/:taskId/decision` 与 `POST /api/travel-applications/:id/withdraw`，参数/错误/通知接收人详见 API.md。服务 `src/server/travel-actions.ts` 导出 `decideTravelTask(token, id, taskId, input: TravelDecisionInput)` 与 `withdrawTravelApplication(token, id, input: TravelWithdrawalInput)`，token 为 string | undefined，其余 ID 为 string；直接服务调用必须先通过 `src/lib/travel-actions.ts` 的 schema 与 UUID 校验。两者自行开事务，返回完整详情。

004 为任务增加激活/完成时间，日志增加版本/任务决策唯一约束。审批/撤回锁申请并核版本，单事务写状态/任务/日志/通知；下一人员不可用时不自动换人。`submittedDetail(client, id, actorId)` 仅用于已做业务身份检查的事务，先锁申请再授权和查询，不能绕过认证单独暴露。已激活任务人员可查历史；未激活取消节点无正文权限。

S3d 已有 GET /api/notifications、GET /api/notifications/:id、GET /api/notifications/unread-count、POST /api/notifications/:id/read。`src/server/notifications.ts` 导出 listNotifications(token, input)、getNotification(token, id)、unreadNotificationCount(token)、markNotificationRead(token, id)，token 为 string | undefined，id 为 UUID string，input 为 NotificationListInput；真实参数/返回与鉴权限制见 API.md。每个服务自行开事务，接收人由会话确定；直接调用前校验输入。005 仅新增未读索引，标记只更新 read_at，重复保留首次时间。

通知事件本身的读取不授予正文权限，返回 target/task 为 null 时不可借通知访问正文；apiPath 指向现有鉴权 API；S3i 从受控 target.type/id 映射到既有差旅详情页。状态与正文跳转后仍需重新读取验证。待办/已办与全状态申请列表 API 已由 S3g 实现；S3h 已接入列表与审批/撤回 UI；S3i 已接入通知 UI 与轮询；S3j 已有固定差旅复制重提接口（见下文），现有能力不等于自定义模块已可完整接入。代码风格统一在 [CONTRIBUTING.md](CONTRIBUTING.md)。

S3e 已有固定差旅附件 API，完整路径/返回见 API.md。`src/server/travel-attachments.ts` 导出 `uploadTravelAttachment(token, id, version, bytes: Buffer, filename, declaredType)`、`listTravelAttachments(token, id)`、`deleteTravelAttachment(token, id, attachmentId, version)`、`getTravelAttachmentContent(token, id, attachmentId)`；token 为 string | undefined，ID/filename/declaredType 为 string，version 为 number，各自开事务。直接调用前校验 UUID/version；HTTP 上传在读正文前还会调用 authorizeAttachmentUpload，实际写入再次鉴权。类型/常量在 `src/lib/attachments.ts`，格式解析在 attachment-validation.ts，私有存储/完整性检查/回收在 attachment-storage.ts。

006 附件表记录所有权关联及校验摘要，存储键不向 HTTP 暴露；上传和删除递增申请 version，提交后冻结。锁顺序为组织 → 存储 72004 共享锁 → 申请；回收独占 72004 并检查数据库引用，避免与上传争抢文件。提交与下载校验原文件，缺失/损坏返回 409。数据库与附件必须配对迁移，具体补偿和恢复边界见 DATABASE.md。这些服务当前仅授权固定差旅，不含动态附件字段或自定义业务接入实现。

S3f 页面使用既有固定差旅接口，见 WEB_TRAVEL.md。requireBusinessPageUser() 在服务端页面内按既有业务身份规则检查；客户端统一 api() 支持 JSON/FormData，并保留 RequestError.code/fieldErrors。src/lib/travel-display.ts 仅描述固定差旅的 HTTP 展示类型，travel-editor.tsx 明确列出固定字段；不得扩展为人工模块的动态字段生成器。PDF.js 只渲染已鉴权附件，public/vendor/pdfjs 是构建生成的第三方库资源，用户原件仍在私有 uploads，不混放。

S3g 新增 GET /api/travel-applications 与 GET /api/travel-tasks。src/server/travel-lists.ts 导出 listTravelApplications(token: string | undefined, input: TravelApplicationListInput)、listTravelTasks(token: string | undefined, input: TravelTaskListInput)，各自开事务；调用前按 src/lib/travel-lists.ts 的 travelApplicationListSchema/travelTaskListSchema 校验输入。返回分页摘要，任务列表另含 state；已办按实际 approved/rejected 任务统计，取消任务不冒充已办。时间、快照姓名、权限与单 SQL 查询一致性详见 API.md，007 仅补固定查询索引。列表不是审批授权凭证，动作仍按最新 taskId/version 校验。

S3h 页面接入见 WEB_TRAVEL_APPROVAL.md，接口和迁移不变。travel-list-page.tsx 按业务身份检查查询入口，travel-list-panel.tsx 沿用固定差旅摘要；travel-decision-panel.tsx 只调用既有固定任务动作，按本次详情的 taskId/version 提交，冲突先重新读取，不自动重放。意见仅在当前详情页面保存，不提供跨会话草稿。

## S5 交接资料索引（已填写）

| 资料                             | 准确入口                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| 代码基线、阶段分支、远程核对     | S5_HANDOFF.md“精确基线与历史”；S4t d54dbe31d29f1b0edf294054330358b3479bce57             |
| 环境、数据库、启动及串行测试命令 | S5_HANDOFF.md“运行、数据和测试”，README.md、DATABASE.md                                 |
| 测试账号/部门/角色与实际审批范围 | S5_HANDOFF.md，tests/e2e/setup.ts；测试库夹具不等于开发演示账号                         |
| 真实公共函数签名/返回类型/文件   | S5_HANDOFF.md“已有接口与函数入口”，本文后续固定业务补充和专项文档                       |
| HTTP方法/路径/鉴权/分页/错误     | API.md及对应src/app/api路由，不存在自定义模块接口                                       |
| 共用表/外键/迁移和事务边界       | S5_HANDOFF.md“数据库与一致性边界”，DATABASE.md，db/migrations/001–017                   |
| 金额/时间/附件/权限及日志/通知   | CONTRIBUTING.md、API.md、STATISTICS.md及业务专项文档                                    |
| 用户独立文件及恢复后的AI范围     | 用户自主决定文件组织；人工模块实现/迁移/测试/动态页面均禁止AI代写或调试，当前全项目停写 |
| 基础验收、限制及人工需求检查     | S5_HANDOFF.md“本轮基线验证”；下列人工验收清单由用户独立执行                             |

## 人工验收清单（需求级别）

- 管理员通过界面创建、编辑、启用/停用模板，普通员工不能执行这些管理操作。
- 创建采购/差旅/报销以外的设备借用流程，员工能选择已启用模板申请；不能修改代码或直接改库来添加这个流程。
- 名称、说明、适用部门、版本与启用状态齐全。
- 单行文本、多行文本、数字或金额、日期、单选、附件字段，名称/必填/必要校验可配置。
- 至少两个顺序节点，可调整次序，支持指定用户和申请人所在部门负责人。
- 发布前拒绝重复字段标识、无效引用、不完整节点、无效审批人规则和循环。
- 自己不能审批自己的申请；无法确定实际审批人时不能静默跳过。
- 发布后版本与已提交实例隔离，模板或人员配置变化不会篡改旧实例；停用后不能用于新申请。
- 通过已有通用能力保留审批历史、附件权限和通知，前后端验证完整；自己编写并保留验证记录。

到 S5 后 AI 停止所有代码修改并交棒。用户完成独立提交并明确要求继续后，再开展允许范围内的后续工作。

S3i 页面见 WEB_NOTIFICATIONS.md。notification-panels.tsx 复用 S3d 通知 API；use-foreground-resource.ts 管理串行读取、隐藏取消、恢复/卸载、超时与旧数据提示；AccountShell 提供未读数与退出暂停上下文。无需新迁移，无动态模板功能。

S3j 新增 GET/POST /api/travel-applications/:id/resubmission。src/server/travel-resubmission.ts 导出 getTravelResubmission(token: string | undefined, id: string): Promise<TravelResubmission> 与 copyTravelForResubmission(token: string | undefined, id: string, version: number): Promise<TravelResubmissionResult>；类型在 src/lib/travel-resubmission.ts。服务自行开事务；直接调用前校验 UUID/version。GET 返回 sourceId/successor（可空），POST 返回 sourceId/successor/created；HTTP 新建 201、复用 200。只有本人 rejected/withdrawn 可调用，POST 先核原版本再复用。

008 为 applications 增加不可变 resubmission_of 自外键与唯一约束；TravelDraft/TravelApplication 的 resubmissionOf 为 string | null。锁顺序为组织/身份/部门 → 原申请 → 已有后续；不改旧申请/审批记录，不复制附件/任务/日志/通知，新草稿使用当前部门，提交重新校验。删除未提交后续允许重建；已提交后续不能覆盖，再次重提从该后续继续。来源关联不授予额外正文权限。UI 在不确定写入后只 GET 核对，不自动重放 POST；详见 API.md、DATABASE.md 与 WEB_TRAVEL_RESUBMISSION.md。此服务仅支持固定差旅。

S4a 已有 POST/GET /api/purchase-drafts、GET/PUT/DELETE /api/purchase-drafts/:id。src/lib/purchase.ts 定义 purchaseDraftSchema、replacePurchaseDraftSchema、purchaseDraftListSchema 和 PurchaseDraftInput、ReplacePurchaseDraftInput、PurchaseDraft、PurchaseDraftSummary；金额/数量输入必须先通过 schema 规范化。src/server/purchase.ts 导出 createPurchaseDraft(token, input)、getPurchaseDraft(token, id)、listPurchaseDrafts(token, input)、replacePurchaseDraft(token, id, input)、deletePurchaseDraft(token, id, version)，token: string | undefined，id: UUID string，version: number；输入类型对应上列 schema，返回详情/分页摘要/删除结果。各自开事务，直接调用前验证 UUID 和 schema；HTTP 边界在 purchase-handlers.ts。

009 新增 purchase_requests / purchase_items / supplier_quotes，应用类型扩展为 travel/purchase；默认 travel 不变。GET 详情持申请共享锁，写持排他锁，均在组织/身份/部门锁之后；稳定行 ID 仅能用于当前草稿同类行，PUT 完整替换，删除省略行。quantity 三位、unitPrice 两位小数，行金额 half-up 到分后精确求和，未完整填写返回 null，不是零。新建/保存部门跟随当前有效身份。采购 POST/PUT 的 JSON 上限 256 KiB，其他仍 16 KiB。S4b 已接入采购报价附件及整单删除文件补偿，S4c 已实现采购提交/详情与提交后文件授权；S4d 已补审批动作，S4e 已补采购列表，S4f 已接入草稿与报价附件 UI，S4g 已接入提交后详情；S4h 已补采购审批/全状态列表 UI，S4i 已补采购复制重提。详见 API.md/DATABASE.md。

S4b 的真实附件路径、参数和返回见 API.md。src/server/purchase-attachments.ts 导出 authorizePurchaseAttachmentUpload(token: string | undefined, id: string, quoteId: string)、uploadPurchaseAttachment(token, id, quoteId, version: number, bytes: Buffer, filename: string, declaredType: string)、listPurchaseAttachments(token, id)、deletePurchaseAttachment(token, id, attachmentId: string, version)、getPurchaseAttachmentContent(token, id, attachmentId)，均自行开事务，直接调用前需校验 UUID/version。返回类型 PurchaseAttachment（src/lib/purchase-attachments.ts）为 Attachment + quoteId；content 返回原 bytes 与不含存储键的元数据。

010 报价复合 FK 保证同申请，采购文件不可改绑/改元数据，非草稿不能写删。purchase.ts 导出 lockPurchaseDraft(client: PoolClient, id: string, ownerId: string, write: boolean)，仅能在已经完成 requireBusinessActor 的事务内使用，返回 version/status，不替代身份校验。上传/删除和整单删除按组织 → 存储 72004 → 申请；读取持申请共享锁。PUT 省略有附件报价返回 QUOTE_HAS_ATTACHMENTS，显式删除附件递增版本后再保存；整单删除先提交元数据删除后回收。共享传输层 attachment-http.ts 仅提取有界 multipart 读取与内容响应头，不包含动态表单/字段解释。S4b 路径仍限制本人草稿；S4c 已在 purchase-applications 路径另行开放提交后读取。

S4c 新增 POST /api/purchase-drafts/:id/submit、GET /api/purchase-applications/:id 以及同前缀附件列表和 content。src/server/purchase-submission.ts 导出 submitPurchaseDraft(token: string | undefined, id: string, version: number) 与 getPurchaseApplication(token, id)，各自开事务返回 application/workflow/tasks/logs；src/server/purchase-attachments.ts 新增 listSubmittedPurchaseAttachments(token, id)、getSubmittedPurchaseAttachmentContent(token, id, attachmentId: string)，自行开事务。完整规则/响应见 API.md，PurchaseRecord 类型见 src/lib/purchase.ts。

事务内 readPurchaseDetail(client: PoolClient, id: string) 不自行鉴权，须先锁申请并授权；lockSubmittedPurchase(client, id, actorId: string) 须先 requireBusinessActor，仅本人或已激活实际任务人员可通过。submittedPurchaseDetail(client, id, actorId) 组合授权及多表读取，不可在未认证事务中单独暴露。固定采购路径由用户确认“部门负责人 → 企业负责人”，fixed-purchase-v1；差旅仍是财务第二步。提交完整性函数只验证固定采购字段，不是未来人工模块的规则解析器。S4c 本身未新增迁移；当前已到 S4n 的 015。S4d 已补采购审批动作，S4e 已补采购列表；S4f 已接入草稿与报价附件页面，S4g 已接入提交与只读详情；S4h 已补采购列表与动作页面，S4i 已补采购复制重提。

S4d 已有 POST /api/purchase-applications/:id/tasks/:taskId/decision 与 POST /api/purchase-applications/:id/withdraw。类型/严格输入在 src/lib/purchase-actions.ts（purchaseDecisionSchema、purchaseWithdrawalSchema、PurchaseDecisionInput、PurchaseWithdrawalInput）；服务 src/server/purchase-actions.ts 导出 decidePurchaseTask(token: string | undefined, id: string, taskId: string, input: PurchaseDecisionInput) 和 withdrawPurchaseApplication(token, id, input: PurchaseWithdrawalInput)，自行开事务返回 application/workflow/tasks/logs。调用服务前校验 UUID 和 schema，HTTP 约束/错误/通知规则见 API.md。

采购动作按原固定人员、taskId 和最新 version 执行，不从角色重新选人；申请行锁覆盖状态/任务/追加日志/通知。审批路径与业务明细/附件均不改写；下一人员不可用则批准回滚，可驳回或本人撤回。终态保持历史权限，未激活即取消的节点无权读取。S4d 本身未新增迁移；当前数据库为 S4n 的 015。S4e 已补采购列表，S4f 已接入采购草稿/附件 UI，S4g 已接入提交与只读详情；S4h 已补采购列表/动作页面，S4i 已补复制重提，不构成人工自定义流程实现；S5 停止全项目代码修改的要求继续有效。

S4e 新增 GET /api/purchase-applications 与 GET /api/purchase-tasks。输入/摘要类型在 src/lib/purchase-lists.ts；src/server/purchase-lists.ts 导出 listPurchaseApplications(token: string | undefined, input: PurchaseApplicationListInput) 和 listPurchaseTasks(token, input: PurchaseTaskListInput)，自行开事务，调用前用 purchaseApplicationListSchema/purchaseTaskListSchema 校验。真实字段/日期/状态筛选与权限见 API.md，不能按列表摘要直接信任后续审批权限。

011 只添加采购按申请人/创建时间排序的部分索引，开发库已应用且数据摘要保持；任务索引继续复用 007。列表总数/分页/状态/金额/版本单 SQL 快照，不取申请行锁；详情/动作仍分别持共享/排他行锁。已办是本人 approved/rejected 任务，取消不计，同人两节点保留两项；金额为精确字符串/null。S4f/S4g 已接入采购草稿、报价附件、提交与只读详情 Web 页面，S4h 已补采购列表/动作页面，S4i 已补复制重提，统计后端S4s已实现，Web尚未接入。S5 人工边界继续有效。

S4f 页面契约见 WEB_PURCHASE.md。purchase-editor.tsx 明确列出固定采购字段，purchase-display.ts 只处理固定采购输入/金额，未生成动态字段或模板解析。新增页面 /purchase/new、/purchase/drafts、/purchase/drafts/:id，复用已有 API，无新迁移。AttachmentItems 的可选 resource 只允许 travel-applications / purchase-drafts / purchase-applications，默认保持原差旅行为；采购上传必须已有 quoteId，附件写入只更新 version，不自动保存文字。冲突/不确定写入停写保留输入，人工核对再重新加载，不自动重放。S5 停止全项目代码修改的边界保持不变。

S4g 新增 /purchase/applications/:id 只读详情，采购编辑器保存后携带最新 version 提交；通知按受控 type/id 映射到差旅/采购详情，正文和文件重新鉴权。src/lib/purchase-submission.ts 的 purchaseSubmissionIssues(input: PurchaseDraftInput, files: readonly {quoteId: string; mimeType: string}[]) 返回 Zod issues，调用前须用 purchaseDraftSchema 规范化，仅验证固定采购字段。服务端仍在事务锁内检查原文件、配额/关联及实际人员，没有信任前端结果。PurchaseDetail HTTP 展示类型和安全购买链接在 purchase-display.ts，附件组件增加固定 purchase-applications 路径选项，无新 API/迁移，无动态模板或字段解释。页面与失败恢复细节见 WEB_PURCHASE.md；S5 全项目停写边界不变。

S4h 真实页面入口及组件契约见 WEB_PURCHASE_APPROVAL.md。PurchaseListPage({mode, searchParams}) 使用 applications/pending/handled 固定模式，查询类型来自 src/lib/purchase-lists.ts。PurchaseDetail({id, viewerId}) 的 viewerId 来自服务端业务身份；PurchaseDecisionPanel 接收 detail、viewerId、opinion 和 onOpinion/onBusy/onDone/reload，按当前详情 taskId/version 调用已有固定 API，不依据角色猜任务。意见仅保存在当前详情组件，重读保留、整页离开丢弃；状态/附件不一致不开放动作。固定差旅/采购类型切换重置查询，不生成动态表单。无新迁移/服务接口，S5 全项目停写边界不变。

S4i 真实契约见 WEB_PURCHASE_RESUBMISSION.md 和 API.md。GET/POST /api/purchase-applications/:id/resubmission 对应 getPurchaseResubmission(token: string | undefined, id: string)、copyPurchaseForResubmission(token: string | undefined, id: string, version: number)，服务自行开事务，调用前校验 UUID/version；返回 PurchaseResubmission / PurchaseResubmissionResult，定义在 src/lib/purchase-resubmission.ts。普通草稿输入拒绝 resubmissionOf，详情 PurchaseDraft / PurchaseRecord 返回该只读可空字段，摘要列表不增加它。

采购复制持组织/身份/部门与原申请锁，原版本核对后复用唯一直接后续或原子创建主表及三张采购明细表。新编号/版本/当前部门、新明细与报价 ID；金额原精度、顺序/拟选/单一来源/未知报价保持，附件与执行记录不复制。提交重新校验线上同报价截图及当前固定审批人员，来源不授予新旧单互相访问权。012 扩展既有数据库来源保护到同类型 travel/purchase，保留旧迁移、唯一/FK 约束。S4i 时数据库为012，013已补固定报销草稿，014已补票据绑定，无动态模板专用结构。PurchaseResubmissionPanel({id, version, appNo, title, onBusy}) 只处理采购固定重提，失败后 GET 核对不自动重放。到 S5 仍停止全项目代码修改。

S4j 固定报销契约在 REIMBURSEMENT_DRAFTS.md / API.md。src/lib/reimbursement.ts 导出 reimbursementDraftSchema、replaceReimbursementDraftSchema、reimbursementDraftListSchema、reimbursementLinkOptionsSchema 及 ReimbursementDraftInput / ReplaceReimbursementDraftInput / ReimbursementDraft / ReimbursementDraftSummary / ReimbursementLinkSummary / ReimbursementLinkedApplication。category 预设五类，明细/关联分别最多100/20，金额字符串/null，合计服务端求和；无票与独立理由可暂缺，尚无提交完整性保证。

src/server/reimbursement.ts 的 createReimbursementDraft(token,input)、getReimbursementDraft(token,id)、listReimbursementDrafts(token,input)、replaceReimbursementDraft(token,id,input)、deleteReimbursementDraft(token,id,version)、listReimbursementLinkOptions(token,input) 各自开事务；token 为 string | undefined，id 为UUID string，input须先用相应schema解析。lockReimbursementDraft(client: PoolClient,id:string,ownerId:string,write:boolean) 须在 requireBusinessActor 之后使用。HTTP 入口 POST/GET /api/reimbursement-drafts、GET/PUT/DELETE /api/reimbursement-drafts/:id、GET /api/reimbursement-link-options，严格输入/Origin/错误约定与旧业务一致。

013 新增报销头、固定费用和 application_links；链来源仅本人已批差旅/采购，不给其他人额外权限，原单不改。写锁报销后按UUID取来源共享锁，明细/链接/版本同事务；完整PUT省略即清空，稳定行ID只属于本单。S4k 已增加票据绑定/附件保护，S4l另已补提交/详情，S4m已补审批动作，S4n已补报销列表接口，S4o已补草稿/票据Web，S4p已补提交/只读详情，S4q已补报销列表审批页面。无自定义字段或规则解释，S5 停止全项目代码修改的边界不变。

S4k 附件真实契约见 REIMBURSEMENT_ATTACHMENTS.md / API.md。src/lib/reimbursement-attachments.ts 导出 receiptNumberSchema 与 ReimbursementAttachment（Attachment加itemId、receiptNumber）。src/server/reimbursement-attachments.ts 导出 authorizeReimbursementAttachmentUpload(token,id,itemId)、uploadReimbursementAttachment(token,id,itemId,version,bytes,filename,declaredType,receiptNumber="")、listReimbursementAttachments(token,id)、deleteReimbursementAttachment(token,id,attachmentId,version)、getReimbursementAttachmentContent(token,id,attachmentId)，均自行开事务。token:string|undefined，各ID:string/UUID，version:number，bytes:Buffer，名称/类型/号码:string；直接调用前校验UUID/version，号码在服务内再次校验。authorize是读取正文前预检，实际写入重新鉴权。

上传返回{attachment,version}，列表{items,totalBytes,version,status}，删除{id,deleted:true,version}，内容服务返回{attachment,bytes}，不暴露storageKey。共享attachmentForm(request,receipt=false)只扩展固定票据的可选receiptNumber字段，旧差旅/采购模式继续严格拒绝它，不是动态字段解析器。014增加报销明细FK/号码/不可改绑触发器，当前迁移到S4n的015。报销delete已使用存储锁并提交后回收，PUT省略带票据行返回ITEM_HAS_ATTACHMENTS；调用者必须使用文件操作后的最新version。S4l已补提交及提交后读取权限，真实接口见下文。S5全项目停写约束不变。

S4l真实契约见REIMBURSEMENT_SUBMISSION.md/API.md。src/lib/reimbursement.ts新增ReimbursementRecord（status五状态、submittedAt:string|null）；src/lib/reimbursement-submission.ts导出reimbursementSubmissionIssues(input:ReimbursementDraftInput,files:readonly {itemId:string}[]):z.core.$ZodIssue[]，调用前须reimbursementDraftSchema规范化，不能替代服务端授权/原文件/事务校验。

src/server/reimbursement-submission.ts导出submitReimbursementDraft(token:string|undefined,id:string,version:number)、getReimbursementApplication(token,id)，自行开事务；输入UUID/version须在调用前校验。submittedReimbursementDetail(client:PoolClient,id:string,actorId:string)在已验证业务身份的事务内组合申请共享锁/授权和多表查询，返回{application,workflow,tasks,logs}。reimbursement-access.ts的lockSubmittedReimbursement(client,id,actorId)须先requireBusinessActor，只授权本人或已激活任务，返回version/status。reimbursement.ts导出readReimbursementDetail(client,id,submittedLinks?:ReimbursementLinkedApplication[]):Promise<ReimbursementRecord>，不自行授权/加申请锁：草稿/提交前及S4r本人终态复制时不传第三参会重核来源所有权；普通提交后详情/审批只允许传已授权实例中的冻结摘要（含空数组），不能用客户端传值。validateReimbursementSubmission(client,saved:ReimbursementRecord)重验固定字段/每行票据或无票原因、原文件与精确总额，返回totalAmount/noReceiptItems/attachmentEvidence；需在持本人申请排他锁且核完关联的事务内调用。

reimbursement-attachments.ts新增listSubmittedReimbursementAttachments(token,id)、getSubmittedReimbursementAttachmentContent(token,id,attachmentId)，各自开事务，沿用S4k元数据/bytes形状。通知API类型新增reimbursement及其受控apiPath，S4p已接报销详情Web链接，正文与文件仍独立鉴权。fixed-reimbursement-v1本部门负责人→财务，S4l时数据库为014，S4n已新增015；审批动作已由S4m实施，人工动态模板/规则解释仍由用户实现，到S5全项目停写。

S4m真实契约见REIMBURSEMENT_ACTIONS.md/API.md。src/lib/reimbursement-actions.ts导出reimbursementDecisionSchema、reimbursementWithdrawalSchema及ReimbursementDecisionInput、ReimbursementWithdrawalInput。src/server/reimbursement-actions.ts导出decideReimbursementTask(token:string|undefined,id:string,taskId:string,input:ReimbursementDecisionInput)、withdrawReimbursementApplication(token:string|undefined,id:string,input:ReimbursementWithdrawalInput)，自行开事务，返回S4l的{application,workflow,tasks,logs}；直接服务调用前必须完成UUID与schema校验。HTTP为POST /api/reimbursement-applications/:id/tasks/:taskId/decision及POST /api/reimbursement-applications/:id/withdraw，入口在reimbursement-action-handlers.ts。

审批按固定实际任务身份和最新version执行，组织/身份/部门锁后持报销申请排他锁；状态、任务、日志、通知一次提交，失败回滚。下一人员不可用不能改派；驳回和本人撤回仍可用。动作不改费用/例外/关联来源/票据或提交快照，返回详情仍使用冻结来源摘要，不沿链接扩大源权限。正文/票据共享申请锁并重验激活授权；已激活人员保留终态历史权限，未激活财务无特权。S4m无新迁移，S4n已补015和固定报销申请/任务列表后端。

S4n类型位于src/lib/reimbursement-lists.ts：reimbursementApplicationListSchema、reimbursementTaskListSchema；ReimbursementApplicationListInput、ReimbursementTaskListInput、ReimbursementApplicationSummary、ReimbursementTaskSummary、ReimbursementList<T>及reimbursementStatuses。服务src/server/reimbursement-lists.ts导出listReimbursementApplications(token:string|undefined,input:ReimbursementApplicationListInput)、listReimbursementTasks(token:string|undefined,input:ReimbursementTaskListInput)，各自开事务并requireBusinessActor；调用前须经对应schema解析，不接受客户端实际身份。返回{items,total,page,pageSize}，任务另有state。

入口reimbursement-list-handlers.ts导出reimbursementApplicationsHandler(request:Request)、reimbursementTasksHandler(request:Request)，由/api/reimbursement-applications与/api/reimbursement-tasks的route.ts导出GET。未知/重复参数拒绝；身份锁后查询，单SQL保证总数/条目/版本/精确金额/无票数/当前节点一致。currentTask与已提交姓名来自实际任务/冻结快照；只读摘要不含源ID/正文/票据，关联不扩权；handled不含cancelled，任务与申请状态独立。金额string|null，noReceiptCount是标记数而非缺票判定。不能把列表当作后续审批授权或预留，仍须核最新version与taskId。契约见REIMBURSEMENT_LISTS.md/API.md。

015仅新增applications_reimbursement_applicant_created_idx，旧任务索引继续使用；新环境迁移001–015，既有库只追加迁移，不重置/seed。S4n没有UI修改；S4o已补固定报销草稿与票据Web页面，修改前须读UI_GUIDELINES.md并查看外层设计，S4p已补提交详情与通知跳转，S4q已补列表动作UI，S4r已补复制重提及016迁移，统计继续分步。S5全项目停写边界不变。

S4o真实Web入口：/reimbursement/new、/reimbursement/drafts、/reimbursement/drafts/:id，页面调用requireBusinessPageUser，草稿正文与附件仍经既有HTTP接口读取，version不一致拒绝编辑。src/components/reimbursement-editor.tsx导出ReimbursementEditor({applicant:string,department:string,initial?:ReimbursementDraft,initialFiles?:ReimbursementAttachment[]})及ExistingReimbursementEditor({id:string,applicant:string,department:string})；reimbursement-drafts-panel.tsx导出ReimbursementDraftsPanel()。ReimbursementSourcePicker({selected:ReimbursementLinkSummary[],onChange:(items:ReimbursementLinkSummary[])=>void,disabled:boolean})使用本人已批来源分页API，不是动态字段或流程解释器。

src/lib/reimbursement-display.ts导出reimbursementCategoryNames、reimbursementFields(draft?:ReimbursementDraft):ReimbursementDraftInput、reimbursementAmount(items:ReimbursementDraftInput["items"]):{total:string|null,overflow:boolean}。字段提取不带服务端身份/合计/关联摘要；金额逐行规范化再BigInt求和，空/缺项/非法输入显示未知。AttachmentItems新增固定resource="reimbursement-drafts"，预览/下载仍独立鉴权。组件锁写并在冲突/不确定响应时保留输入停写；两个GET版本匹配后才编辑，人工确认才丢弃本地修改。真实操作与限制见WEB_REIMBURSEMENT.md。

S4o不增加API或迁移，仍015；S4p已接固定报销提交与只读详情/票据和通知跳转，按S4l合同先保存后提交、展示冻结来源与无票例外。S4q已补报销全状态/任务列表与审批操作页面，S4r已接固定报销复制重提，S4s已补固定业务统计后端，下一增量S4t接入统计Web，S5全项目停写边界不变。

S4p真实Web契约见WEB_REIMBURSEMENT_SUBMISSION.md。新增/reimbursement/applications/:id，页面校验业务身份/UUID；src/components/reimbursement-detail.tsx导出ReimbursementDetail({id:string,viewerId:string})（S4q增加服务端身份），HTTP展示类型ReimbursementDetail在src/lib/reimbursement-display.ts，明确固定routeSnapshot/tasks/logs。正文与票据version/status匹配才展示；冻结来源摘要不查询或链接源全文，顶部/逐行显示无票原因。AttachmentItems的固定resource增加reimbursement-applications，预览下载保持独立鉴权。

ReimbursementEditor原签名不变，完整校验调用现有reimbursementSubmissionIssues，确认后保存并使用返回version提交；保存失败不提交，未知提交结果停写并提供新窗口核对已提交详情，不自动重放。NotificationDetailPanel固定映射加入reimbursement，读通知/跳转不自动标已读。无新API/迁移，仍015；S4q已接报销列表/动作UI。用户明确要求保持当前依赖版本，不执行Next升级；S5仍停止全项目代码修改。

S4q Web契约见WEB_REIMBURSEMENT_APPROVAL.md：/reimbursement/applications、/reimbursement/tasks、/reimbursement/tasks/handled由ReimbursementListPage({mode,searchParams:Promise<Record<string,string|string[]|undefined>>})鉴权/校验URL，ReimbursementListPanel({mode:ReimbursementListMode,input:ReimbursementApplicationListInput})读取对应现有API。mode固定applications/pending/handled，导航另含drafts；不会合并三类业务金额。默认每页10，时间依次createdAt/activatedAt/finishedAt；type只接受reimbursement，state由路由决定。

ReimbursementDecisionPanel({detail:ReimbursementDetail,viewerId:string,opinion:string,onOpinion:(value:string)=>void,onBusy:(value:boolean)=>void,onDone:(message:string)=>void,reload:()=>void})使用既有decision/withdrawal schema，只有本人pending或当前已激活实际节点提供按钮。viewerId由requireBusinessPageUser取得；API继续独立授权。详情组件保存意见，成功清空并重读正文/票据，冲突/404/网络/5xx停写，手动重新读取保留意见；整页离开/会话失效可能丢失。实际taskId/version来自匹配的最新详情，无自动重放/改派/下一步审批。数据库仍015，现有后端签名不变；S4r已另行实现固定报销复制重提，当前数据库新增016，到S5仍停止整个项目代码修改。

S4r真实契约见API.md与WEB_REIMBURSEMENT_RESUBMISSION.md。src/server/reimbursement-resubmission.ts导出getReimbursementResubmission(token:string|undefined,id:string):Promise<ReimbursementResubmission>和copyReimbursementForResubmission(token,id,version:number):Promise<ReimbursementResubmissionResult>，自行事务；UUID与严格整数version由handler先校验。GET/POST /api/reimbursement-applications/:id/resubmission不接受查询参数，POST只收{version}，201创建/200复用，返回{sourceId,successor:{id,appNo,status,version},created}；GET无created且successor可null。只限本人rejected/withdrawn，实际审批人及管理员无额外权限。

普通报销草稿/提交详情新增resubmissionOf:string|null，只读不可由POST/PUT注入；reimbursementFields仍只发固定可编辑字段。复制使用当前确认部门、全新费用行ID，保留NUMERIC及显式无票/独立说明和合格采购/差旅来源，不复制票据/号码/人员/历史。readReimbursementDetail(client,id)不传冻结摘要的分支仅在本人持锁复制时可用于重核实时源资格；提交后普通读取仍必须传已授权的冻结摘要。

016仅扩大preserve_travel_resubmission历史命名函数的固定类型白名单至报销，沿用008唯一后续/自引用/外键和012不可变保护。新环境迁移001–016；既有库追加，不重置/seed。锁顺序组织/身份/部门→原报销→已有后续或UUID排序来源→新记录，所有复制表写入失败回滚，不改原版本/时间/执行与文件。已有后续只返回当前标识，不覆盖内容；删除未提交后续可重建，已提交沿后续延长链。

ReimbursementResubmissionPanel({id:string,version:number,appNo:string,title:string,onBusy:(busy:boolean)=>void})由本人终态详情挂载，GET关系、确认POST，失败暂停并GET核对；版本冲突重新读取整份详情。复制期间协调父组件禁用刷新/票据，新草稿/详情向本人提供原申请链接。新旧正文权限独立，来源关系不授权历史审批人。S4s已补统计后端、Web待S4t；到S5仍停止全项目代码修改。

S4s真实契约见STATISTICS.md与API.md。src/server/statistics.ts导出getFixedBusinessStatistics(token:string|undefined,input:StatisticsInput):Promise<FixedBusinessStatistics>，服务校验schema并自行事务/鉴权；src/server/statistics-handlers.ts导出statisticsHandler(request:Request)，/api/statistics/route.ts只映射GET。statisticsSchema/statisticsTypes/statisticsStatuses及StatisticsInput/StatisticsType/StatisticsCounts/FixedBusinessStatistics见src/lib/statistics.ts；不需要或允许客户端提供申请人/实际部门授权。

scope默认personal，仅本人已提交申请；department只给当前有效department_head所属部门汇总，其他角色不隐含公司/财务权限，显式他部门403。pendingTasks永远是调用者的实际当前待办，独立于本人申请，但接受同样的提交日/部门/类型筛选。时间统一submitted_at上海日历日，草稿排除、当前状态分布；金额仅approved并按采购总额/差旅预算/报销总额分开，string|null及缺失计数不可变成浮点/零。汇总不授予正文/文件访问或审批权，页面不要根据统计直接构造审批动作。

017仅新增两个提交时间部分索引，数据读取同一SQL快照，组织锁后重验会话/当前角色/部门；不改通知或记录，不取业务行锁。现有申请部门保持提交时归属，新任负责人可看汇总但未分配历史正文仍404。统计Web/图表尚未实现，下一阶段S4t按设计接入；到S5停止整个项目代码修改，人工模块边界不变。

S4t已接入 /statistics，服务端页面严格检查参数/当前角色与部门，客户端StatisticsPanel读取已有GET统计并按真实filters显示数量、状态横条、分类批准金额和独立本人待办。加载/失败隐藏旧结果、手动刷新恢复、迟到请求不覆盖新条件；不授权正文/票据、不标记通知、不写审批。页面与验收见WEB_STATISTICS.md，无新API/迁移/依赖；S5停止整个项目代码修改。
