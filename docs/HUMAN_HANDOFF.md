# 人工模块交接边界

**当前状态：尚未到交接点。** 当前完成 S0/S1 与 S2 身份管理（数据库、接口、Web 页面及浏览器验收）；S3a–S3e 固定差旅审批、本人通知与受控附件后端也已完成，S3f 已接入差旅草稿/附件/提交与只读详情页面；S3g 已完成固定差旅全状态及待办/已办列表后端；下一步 S3h 接入列表与审批/撤回页面。后续在 S4 完成后更新为可直接接棒的完整真实接口清单。最新进度见 STATUS.md。本文不是自定义模块实现方案，不含代码或实现伪代码。

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

002 迁移建立 applications / travel_requests；目前仅允许固定 travel 类型，不包含动态字段、流程模板、版本发布或规则解析。草稿的公共主表不是自定义模块已经可接入的承诺，后续 S3–S4 仍需补齐固定业务能力。

S3b 已有 `POST /api/travel-drafts/:id/submit`（只收 version）和 `GET /api/travel-applications/:id`。服务在 `src/server/travel-submission.ts`：`submitTravelDraft(token: string | undefined, id: string, version: number)` 与 `getTravelApplication(token: string | undefined, id: string)`，返回 application/workflow/tasks/logs。服务自行开事务，HTTP 参数校验和权限契约见 API.md；固定 v1 的两步选择只适用于差旅，不是通用配置解析器。

`src/server/business-auth.ts` 的 `requireBusinessActor(token: string | undefined, client: PoolClient)` 是草稿/提交共用的事务内身份检查，先组织 72002 共享锁，再会话/有效部门锁；不能在事务外使用。状态变更还须锁申请行，先核版本后写业务、待办、日志、通知；组织写入使用同号排他锁。

003 新增固定执行所需 approval_instances/tasks/logs/notifications，实例与日志不可更新/删除，首个任务 pending、下一步 blocked。通知按接收人和事件键去重。当前用固定版本标识与不可变 JSON 快照，不含模板配置/发布/版本表或动态字段；完整模型及真实可复用边界到 S4 再冻结。

S3c 已有 `POST /api/travel-applications/:id/tasks/:taskId/decision` 与 `POST /api/travel-applications/:id/withdraw`，参数/错误/通知接收人详见 API.md。服务 `src/server/travel-actions.ts` 导出 `decideTravelTask(token, id, taskId, input: TravelDecisionInput)` 与 `withdrawTravelApplication(token, id, input: TravelWithdrawalInput)`，token 为 string | undefined，其余 ID 为 string；直接服务调用必须先通过 `src/lib/travel-actions.ts` 的 schema 与 UUID 校验。两者自行开事务，返回完整详情。

004 为任务增加激活/完成时间，日志增加版本/任务决策唯一约束。审批/撤回锁申请并核版本，单事务写状态/任务/日志/通知；下一人员不可用时不自动换人。`submittedDetail(client, id, actorId)` 仅用于已做业务身份检查的事务，先锁申请再授权和查询，不能绕过认证单独暴露。已激活任务人员可查历史；未激活取消节点无正文权限。

S3d 已有 GET /api/notifications、GET /api/notifications/:id、GET /api/notifications/unread-count、POST /api/notifications/:id/read。`src/server/notifications.ts` 导出 listNotifications(token, input)、getNotification(token, id)、unreadNotificationCount(token)、markNotificationRead(token, id)，token 为 string | undefined，id 为 UUID string，input 为 NotificationListInput；真实参数/返回与鉴权限制见 API.md。每个服务自行开事务，接收人由会话确定；直接调用前校验输入。005 仅新增未读索引，标记只更新 read_at，重复保留首次时间。

通知事件本身的读取不授予正文权限，返回 target/task 为 null 时不可借通知访问正文；apiPath 指向现有鉴权 API，不是已实现的页面。状态与正文跳转后仍需重新读取验证。待办/已办与全状态申请列表 API 已由 S3g 实现；这些列表的 UI、复制重提接口与审批/撤回/通知 UI、轮询仍**未实现**，现有能力不等于自定义模块已可完整接入。代码风格统一在 [CONTRIBUTING.md](CONTRIBUTING.md)。

S3e 已有固定差旅附件 API，完整路径/返回见 API.md。`src/server/travel-attachments.ts` 导出 `uploadTravelAttachment(token, id, version, bytes: Buffer, filename, declaredType)`、`listTravelAttachments(token, id)`、`deleteTravelAttachment(token, id, attachmentId, version)`、`getTravelAttachmentContent(token, id, attachmentId)`；token 为 string | undefined，ID/filename/declaredType 为 string，version 为 number，各自开事务。直接调用前校验 UUID/version；HTTP 上传在读正文前还会调用 authorizeAttachmentUpload，实际写入再次鉴权。类型/常量在 `src/lib/attachments.ts`，格式解析在 attachment-validation.ts，私有存储/完整性检查/回收在 attachment-storage.ts。

006 附件表记录所有权关联及校验摘要，存储键不向 HTTP 暴露；上传和删除递增申请 version，提交后冻结。锁顺序为组织 → 存储 72004 共享锁 → 申请；回收独占 72004 并检查数据库引用，避免与上传争抢文件。提交与下载校验原文件，缺失/损坏返回 409。数据库与附件必须配对迁移，具体补偿和恢复边界见 DATABASE.md。这些服务当前仅授权固定差旅，不含动态附件字段或自定义业务接入实现。

S3f 页面使用既有固定差旅接口，见 WEB_TRAVEL.md。requireBusinessPageUser() 在服务端页面内按既有业务身份规则检查；客户端统一 api() 支持 JSON/FormData，并保留 RequestError.code/fieldErrors。src/lib/travel-display.ts 仅描述固定差旅的 HTTP 展示类型，travel-editor.tsx 明确列出固定字段；不得扩展为人工模块的动态字段生成器。PDF.js 只渲染已鉴权附件，public/vendor/pdfjs 是构建生成的第三方库资源，用户原件仍在私有 uploads，不混放。

S3g 新增 GET /api/travel-applications 与 GET /api/travel-tasks。src/server/travel-lists.ts 导出 listTravelApplications(token: string | undefined, input: TravelApplicationListInput)、listTravelTasks(token: string | undefined, input: TravelTaskListInput)，各自开事务；调用前按 src/lib/travel-lists.ts 的 travelApplicationListSchema/travelTaskListSchema 校验输入。返回分页摘要，任务列表另含 state；已办按实际 approved/rejected 任务统计，取消任务不冒充已办。时间、快照姓名、权限与单 SQL 查询一致性详见 API.md，007 仅补固定查询索引。列表不是审批授权凭证，动作仍按最新 taskId/version 校验。

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
