# S4m 固定报销审批与撤回

本阶段提供报销当前任务通过/驳回及本人撤回的后端接口。沿用 S4l 冻结的“部门负责人 → 财务审批人”，不重新解析角色或改写路径。无新增迁移，当时为 014；S4n 已补列表及 015 索引，S4q已接入列表和审批/撤回Web页面（WEB_REIMBURSEMENT_APPROVAL.md），S4r已接入复制重提（WEB_REIMBURSEMENT_RESUBMISSION.md），统计继续分步。

## 接口与输入

- `POST /api/reimbursement-applications/:id/tasks/:taskId/decision`：严格 JSON `{ version, decision: "approve" | "reject", opinion? }`。
- `POST /api/reimbursement-applications/:id/withdraw`：严格 JSON `{ version, opinion? }`。

ID 为 UUID；version 为最新正整数。opinion 去除首尾空白、最多 2000 字符，默认空；驳回必须有理由。两个接口均不接受查询参数，正文上限 16 KiB，沿用 Cookie 同源/Bearer 鉴权。成功 HTTP 200，返回 S4l 的 `{ application, workflow, tasks, logs }`，不得自动重放失败请求；失败或结果未知先重新读取详情。

## 流转与授权

只有当前 pending 实际任务人员可审批，申请人不得自审。前序必须全部 approved，未激活的财务不能提前处理；旧 taskId 即使配合新 version 也不能批准下一节点，同一人兼任两步仍须分别处理。普通管理员、企业负责人、新任负责人或财务角色本身均不授予旧单任务权限。

首节点通过后关闭当前任务并激活原财务人员；财务通过后申请 approved。任一节点驳回后申请 rejected，未办任务 cancelled。本人在任一 pending 节点可撤回为 withdrawn，取消未办并保留已办结果；终态拒绝重复审批或撤回，不能恢复为草稿或删除历史。

下一冻结人员停用、所属部门失效或异常变为申请人时，批准返回 APPROVER_UNAVAILABLE 并整体回滚，不改派、跳过或部分批准。角色调整不替换已冻结实际人员；有效账号仍可处理原任务。驳回及本人撤回不依赖下一人员有效性。

## 事务、通知及证据

锁顺序为组织/身份/部门 → 报销申请 FOR UPDATE；状态、版本、任务时间、追加日志与通知在同一事务完成。每次成功 version+1，只更新申请状态/更新时间与执行记录；正文、精确金额、费用、无票例外、来源关联、提交时间、票据及人员/证据快照保持。审批读取提交时的来源摘要，不重新查询来源正文，不向报销审批人扩大源申请或附件权限。

新节点激活通知其实际人员；通过/驳回通知申请人；撤回通知申请人及曾激活节点人员，按人去重。未激活即取消的财务没有撤回通知或正文/票据权限。通知标题属于历史事件，target.status/task.status 按当前状态读取，不能凭旧待办通知重复操作。

详情及票据读取沿用申请共享锁和锁后授权。有效身份的申请人及曾激活实际人员保留终态正文/原文件读取权，管理员与未激活人员没有特权。部门批准未提交时，财务的并发读取等待同一申请锁，事务提交后再核验激活权限，不观察部分流转结果。

## 验证与接续

`tests/reimbursement-actions.test.ts` 覆盖两级通过、首末节点驳回/撤回、输入与身份、版本/任务/跨业务隔离、并发、故障回滚、失效人员、等锁后授权、终态票据和真实已批来源不变。`scripts/smoke-identity.mjs` 经生产 HTTP 验证五种路径、通知及 Web 重启后的终态、快照和票据原字节。实际执行结果以 STATUS.md / DEVELOPMENT_LOG.md 为准。

S4n 已补固定报销本人全状态申请、待办/已办列表后端，见 REIMBURSEMENT_LISTS.md；后续S4o–S4r已接入Web页面及复制重提，统计继续分步。S4m本阶段无UI修改，不新增浏览器截图结论。S5 仍须停止全项目代码修改，由用户独立实现自定义模块。
