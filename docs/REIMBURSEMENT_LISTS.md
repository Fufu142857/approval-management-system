# S4n 固定报销申请与任务列表

本阶段实现两个只读后端接口；Web 页面和复制重提继续分步。列表只表示查询时状态，操作仍须读取详情并使用最新 version 与实际 taskId。

| 接口                                | 范围                                                          | 时间筛选与排序                                                |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| GET /api/reimbursement-applications | 当前用户本人全部状态的报销申请                                | createdAt 降序、id 升序                                       |
| GET /api/reimbursement-tasks        | state=pending 当前实际待办；state=handled 本人通过/驳回的任务 | pending 按 activatedAt；handled 按 finishedAt，降序后 id 升序 |

共用查询参数：page（1–100000，默认1）、pageSize（1–100，默认20）、type（只允许 reimbursement，默认同值）、status（all/draft/pending/approved/rejected/withdrawn，默认all）、keyword（去首尾空白，最多200字符）、from/to（0001-01-01至9999-12-31的有效ISO日期，可单独使用，from不晚于to）。任务另收state，默认pending。status始终筛选申请当前状态，不是任务结果；关键词只匹配标题/编号，忽略大小写、按字面量搜索，%和_没有通配含义。未知、重复、非法参数返回400 VALIDATION_ERROR，不接受申请人/部门/角色/审批人注入。

from/to按Asia/Shanghai日历日包含首尾，通过半开时间区间比较。全状态申请列表按创建时间，和原有草稿专用列表按更新时间不同。分页返回{items,total,page,pageSize}；任务另含state。total统计筛选后全部结果，越界页items为空但total保留。响应使用Cache-Control: no-store。

申请摘要包含id、appNo、type、title、status、version、totalAmount、noReceiptCount、applicant{id,name,departmentId,departmentName}、createdAt/updatedAt/submittedAt及currentTask。currentTask只包含当前已激活pending节点的{id,seqNo,name,approver:{id,name}}，草稿和终态为null。已提交的申请人/部门名和节点审批人名来自不可变提交快照，草稿姓名来自当前存储身份。不会返回完整费用行、正文、无票原因、来源ID/摘要、票据元数据/字节或未来节点。

totalAmount由PostgreSQL NUMERIC精确求和，返回两位小数字符串，不经浮点Number；零条明细或任一金额缺失返回null，不能当零。noReceiptCount只计明细显式noReceipt=true，不等同于缺文件数量、提交可行性或财务批准；有票/无票完整性仍在提交时检查，例外原因需按详情权限读取。

任务摘要包含id、seqNo、name、status、activatedAt、finishedAt和application摘要。pending要求当前实际人员、任务已激活、申请pending且全部前序已通过；handled只收approved/rejected，取消任务不计已办。同人兼任两步保留两条实际任务，不能按申请去重。例如部门已通过、随后本人撤回时，部门已办仍为approved，application.status为withdrawn。

所有读取在事务内先requireBusinessActor，取得组织共享锁并验证有效会话、身份和部门。管理员、财务或企业负责人角色不扩大本人申请范围；任务按冻结实际人员，不按当前角色重选。关联差旅/采购不增加列表范围或源单权限，旧业务列表与报销独立。列表不更改申请、任务、日志、通知或已读时间。

每次items、total、版本、金额、无票数与当前节点来自同一SQL快照，避免并发审批或多表草稿保存暴露部分状态；跨请求不承诺相同快照。此机制不锁定待办供以后操作，也不替代审批事务的最新版本/任务核验。

实现位于src/lib/reimbursement-lists.ts、src/server/reimbursement-lists.ts和reimbursement-list-handlers.ts。015_reimbursement_list_index.sql只新增报销本人创建时间部分索引，复用既有任务索引，不更新业务记录。测试覆盖权限、实际任务、终态/取消、同人两步、姓名快照、日期/字面量搜索、分页、精确金额、并发一致性、来源隔离及查询无副作用；真实HTTP及Web重启结果见STATUS.md。

S4o已实现固定报销草稿与票据Web页面（WEB_REIMBURSEMENT.md），界面前须复核外层Design.pdf和UI_GUIDELINES.md；提交详情、列表动作页面、重提与统计继续拆分。到S5仍停止整个项目代码修改并交棒。
