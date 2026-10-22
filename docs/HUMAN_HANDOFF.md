# 人工模块交接边界

**当前状态：尚未到交接点。** 当前完成 S0/S1 与 S2 身份管理（数据库、接口、Web 页面及浏览器验收）；S3a–S3e 固定差旅审批、本人通知与受控附件后端也已完成，S3f 已接入差旅草稿/附件/提交与只读详情页面；S3g 已完成固定差旅全状态及待办/已办列表后端；S3h 已接入列表与审批/撤回页面；S3i 已接入通知页面与前台轮询；S3j 已完成差旅复制重提；S4a 已完成固定采购数据模型与草稿后端；S4b 已实现采购报价附件；S4c 已完成固定采购提交与提交后详情，S4d 已完成固定采购审批动作，S4e 已完成采购申请与任务列表后端，S4f 已接入采购草稿与报价附件页面，S4g 已接入采购提交与提交后只读详情，S4h 已接入采购列表与审批操作页面，S4i 已接入采购复制重提，S4j 已完成固定报销草稿后端，S4k 已完成报销票据附件后端，下一步 S4l 报销提交与提交后详情。后续在 S4 完成后更新为可直接接棒的完整真实接口清单。最新进度见 STATUS.md。本文不是自定义模块实现方案，不含代码或实现伪代码。

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

002 迁移建立 applications / travel_requests；013 已扩展为固定 travel/purchase/reimbursement 类型，不包含动态字段、流程模板、版本发布或规则解析。草稿的公共主表不是自定义模块已经可接入的承诺，后续 S3–S4 仍需补齐固定业务能力。

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

## 到达 S5 前必须填写的交接资料

| 资料                                           | 当前状态                                                   |
| ---------------------------------------------- | ---------------------------------------------------------- |
| 基线 commit、工作分支、远程推送结果            | 待 S4 完成时锁定                                           |
| 环境安装、数据库初始化、启动和测试命令         | README/DATABASE 已有身份运行与测试；S3–S4 补业务命令       |
| 测试账号、角色、部门与批准权限范围             | 本地 admin 密码来自 .env，仅系统管理；业务审批账号待 S3–S4 |
| 已有公共函数的真实文件、导出签名、参数与返回值 | 待 S4 从实际代码提取                                       |
| HTTP 方法/路径、鉴权、成功和错误响应、分页     | 待 S4 从实际接口提取                                       |
| 共用表、外键、迁移编号和事务责任边界           | 待 S4 锁定；人工模块专用迁移由用户编写                     |
| 金额/时间/附件/权限及日志/通知约束             | 原则见 CONTRIBUTING；具体实现待补                          |
| 用户拥有的文件与 AI 后续允许修改的范围         | 待用户实际文件组织确定                                     |
| 基础验收和人工模块演示检查表                   | 需求清单已列出，基线测试待 S4                              |

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

事务内 readPurchaseDetail(client: PoolClient, id: string) 不自行鉴权，须先锁申请并授权；lockSubmittedPurchase(client, id, actorId: string) 须先 requireBusinessActor，仅本人或已激活实际任务人员可通过。submittedPurchaseDetail(client, id, actorId) 组合授权及多表读取，不可在未认证事务中单独暴露。固定采购路径由用户确认“部门负责人 → 企业负责人”，fixed-purchase-v1；差旅仍是财务第二步。提交完整性函数只验证固定采购字段，不是未来人工模块的规则解析器。S4c 本身未新增迁移；当前已到 S4k 的 014。S4d 已补采购审批动作，S4e 已补采购列表；S4f 已接入草稿与报价附件页面，S4g 已接入提交与只读详情；S4h 已补采购列表与动作页面，S4i 已补采购复制重提。

S4d 已有 POST /api/purchase-applications/:id/tasks/:taskId/decision 与 POST /api/purchase-applications/:id/withdraw。类型/严格输入在 src/lib/purchase-actions.ts（purchaseDecisionSchema、purchaseWithdrawalSchema、PurchaseDecisionInput、PurchaseWithdrawalInput）；服务 src/server/purchase-actions.ts 导出 decidePurchaseTask(token: string | undefined, id: string, taskId: string, input: PurchaseDecisionInput) 和 withdrawPurchaseApplication(token, id, input: PurchaseWithdrawalInput)，自行开事务返回 application/workflow/tasks/logs。调用服务前校验 UUID 和 schema，HTTP 约束/错误/通知规则见 API.md。

采购动作按原固定人员、taskId 和最新 version 执行，不从角色重新选人；申请行锁覆盖状态/任务/追加日志/通知。审批路径与业务明细/附件均不改写；下一人员不可用则批准回滚，可驳回或本人撤回。终态保持历史权限，未激活即取消的节点无权读取。S4d 本身未新增迁移；当前数据库为 S4k 的 014。S4e 已补采购列表，S4f 已接入采购草稿/附件 UI，S4g 已接入提交与只读详情；S4h 已补采购列表/动作页面，S4i 已补复制重提，不构成人工自定义流程实现；S5 停止全项目代码修改的要求继续有效。

S4e 新增 GET /api/purchase-applications 与 GET /api/purchase-tasks。输入/摘要类型在 src/lib/purchase-lists.ts；src/server/purchase-lists.ts 导出 listPurchaseApplications(token: string | undefined, input: PurchaseApplicationListInput) 和 listPurchaseTasks(token, input: PurchaseTaskListInput)，自行开事务，调用前用 purchaseApplicationListSchema/purchaseTaskListSchema 校验。真实字段/日期/状态筛选与权限见 API.md，不能按列表摘要直接信任后续审批权限。

011 只添加采购按申请人/创建时间排序的部分索引，开发库已应用且数据摘要保持；任务索引继续复用 007。列表总数/分页/状态/金额/版本单 SQL 快照，不取申请行锁；详情/动作仍分别持共享/排他行锁。已办是本人 approved/rejected 任务，取消不计，同人两节点保留两项；金额为精确字符串/null。S4f/S4g 已接入采购草稿、报价附件、提交与只读详情 Web 页面，S4h 已补采购列表/动作页面，S4i 已补复制重提，统计尚未实现。S5 人工边界继续有效。

S4f 页面契约见 WEB_PURCHASE.md。purchase-editor.tsx 明确列出固定采购字段，purchase-display.ts 只处理固定采购输入/金额，未生成动态字段或模板解析。新增页面 /purchase/new、/purchase/drafts、/purchase/drafts/:id，复用已有 API，无新迁移。AttachmentItems 的可选 resource 只允许 travel-applications / purchase-drafts / purchase-applications，默认保持原差旅行为；采购上传必须已有 quoteId，附件写入只更新 version，不自动保存文字。冲突/不确定写入停写保留输入，人工核对再重新加载，不自动重放。S5 停止全项目代码修改的边界保持不变。

S4g 新增 /purchase/applications/:id 只读详情，采购编辑器保存后携带最新 version 提交；通知按受控 type/id 映射到差旅/采购详情，正文和文件重新鉴权。src/lib/purchase-submission.ts 的 purchaseSubmissionIssues(input: PurchaseDraftInput, files: readonly {quoteId: string; mimeType: string}[]) 返回 Zod issues，调用前须用 purchaseDraftSchema 规范化，仅验证固定采购字段。服务端仍在事务锁内检查原文件、配额/关联及实际人员，没有信任前端结果。PurchaseDetail HTTP 展示类型和安全购买链接在 purchase-display.ts，附件组件增加固定 purchase-applications 路径选项，无新 API/迁移，无动态模板或字段解释。页面与失败恢复细节见 WEB_PURCHASE.md；S5 全项目停写边界不变。

S4h 真实页面入口及组件契约见 WEB_PURCHASE_APPROVAL.md。PurchaseListPage({mode, searchParams}) 使用 applications/pending/handled 固定模式，查询类型来自 src/lib/purchase-lists.ts。PurchaseDetail({id, viewerId}) 的 viewerId 来自服务端业务身份；PurchaseDecisionPanel 接收 detail、viewerId、opinion 和 onOpinion/onBusy/onDone/reload，按当前详情 taskId/version 调用已有固定 API，不依据角色猜任务。意见仅保存在当前详情组件，重读保留、整页离开丢弃；状态/附件不一致不开放动作。固定差旅/采购类型切换重置查询，不生成动态表单。无新迁移/服务接口，S5 全项目停写边界不变。

S4i 真实契约见 WEB_PURCHASE_RESUBMISSION.md 和 API.md。GET/POST /api/purchase-applications/:id/resubmission 对应 getPurchaseResubmission(token: string | undefined, id: string)、copyPurchaseForResubmission(token: string | undefined, id: string, version: number)，服务自行开事务，调用前校验 UUID/version；返回 PurchaseResubmission / PurchaseResubmissionResult，定义在 src/lib/purchase-resubmission.ts。普通草稿输入拒绝 resubmissionOf，详情 PurchaseDraft / PurchaseRecord 返回该只读可空字段，摘要列表不增加它。

采购复制持组织/身份/部门与原申请锁，原版本核对后复用唯一直接后续或原子创建主表及三张采购明细表。新编号/版本/当前部门、新明细与报价 ID；金额原精度、顺序/拟选/单一来源/未知报价保持，附件与执行记录不复制。提交重新校验线上同报价截图及当前固定审批人员，来源不授予新旧单互相访问权。012 扩展既有数据库来源保护到同类型 travel/purchase，保留旧迁移、唯一/FK 约束。S4i 时数据库为012，013已补固定报销草稿，014已补票据绑定，无动态模板专用结构。PurchaseResubmissionPanel({id, version, appNo, title, onBusy}) 只处理采购固定重提，失败后 GET 核对不自动重放。到 S5 仍停止全项目代码修改。

S4j 固定报销契约在 REIMBURSEMENT_DRAFTS.md / API.md。src/lib/reimbursement.ts 导出 reimbursementDraftSchema、replaceReimbursementDraftSchema、reimbursementDraftListSchema、reimbursementLinkOptionsSchema 及 ReimbursementDraftInput / ReplaceReimbursementDraftInput / ReimbursementDraft / ReimbursementDraftSummary / ReimbursementLinkSummary / ReimbursementLinkedApplication。category 预设五类，明细/关联分别最多100/20，金额字符串/null，合计服务端求和；无票与独立理由可暂缺，尚无提交完整性保证。

src/server/reimbursement.ts 的 createReimbursementDraft(token,input)、getReimbursementDraft(token,id)、listReimbursementDrafts(token,input)、replaceReimbursementDraft(token,id,input)、deleteReimbursementDraft(token,id,version)、listReimbursementLinkOptions(token,input) 各自开事务；token 为 string | undefined，id 为UUID string，input须先用相应schema解析。lockReimbursementDraft(client: PoolClient,id:string,ownerId:string,write:boolean) 须在 requireBusinessActor 之后使用。HTTP 入口 POST/GET /api/reimbursement-drafts、GET/PUT/DELETE /api/reimbursement-drafts/:id、GET /api/reimbursement-link-options，严格输入/Origin/错误约定与旧业务一致。

013 新增报销头、固定费用和 application_links；链来源仅本人已批差旅/采购，不给其他人额外权限，原单不改。写锁报销后按UUID取来源共享锁，明细/链接/版本同事务；完整PUT省略即清空，稳定行ID只属于本单。S4k 已增加票据绑定/附件保护，不能声称已有报销提交/审批/页面接口。无自定义字段或规则解释，S5 停止全项目代码修改的边界不变。

S4k 附件真实契约见 REIMBURSEMENT_ATTACHMENTS.md / API.md。src/lib/reimbursement-attachments.ts 导出 receiptNumberSchema 与 ReimbursementAttachment（Attachment加itemId、receiptNumber）。src/server/reimbursement-attachments.ts 导出 authorizeReimbursementAttachmentUpload(token,id,itemId)、uploadReimbursementAttachment(token,id,itemId,version,bytes,filename,declaredType,receiptNumber="")、listReimbursementAttachments(token,id)、deleteReimbursementAttachment(token,id,attachmentId,version)、getReimbursementAttachmentContent(token,id,attachmentId)，均自行开事务。token:string|undefined，各ID:string/UUID，version:number，bytes:Buffer，名称/类型/号码:string；直接调用前校验UUID/version，号码在服务内再次校验。authorize是读取正文前预检，实际写入重新鉴权。

上传返回{attachment,version}，列表{items,totalBytes,version,status}，删除{id,deleted:true,version}，内容服务返回{attachment,bytes}，不暴露storageKey。共享attachmentForm(request,receipt=false)只扩展固定票据的可选receiptNumber字段，旧差旅/采购模式继续严格拒绝它，不是动态字段解析器。014增加报销明细FK/号码/不可改绑触发器，当前迁移到014。报销delete已使用存储锁并提交后回收，PUT省略带票据行返回ITEM_HAS_ATTACHMENTS；调用者必须使用文件操作后的最新version。S4l才补提交及提交后读取权限，不能提前调用未实现的接口。S5全项目停写约束不变。
