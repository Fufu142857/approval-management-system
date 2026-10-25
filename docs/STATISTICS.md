# S4s 固定业务统计后端

GET /api/statistics 提供本人已提交申请、本人实际待办，以及当前部门负责人的部门汇总。依据作业查询统计要求及设计第3.4节：按提交时间统计数量/状态，已批准的采购总额、差旅预算、报销总额分别合计。接口只覆盖三类固定业务；S4t已接入页面/状态图，见WEB_STATISTICS.md，自定义业务不在范围内。

## 查询及权限

| 参数         | 默认                           | 约束                                           |
| ------------ | ------------------------------ | ---------------------------------------------- |
| scope        | personal                       | personal或department                           |
| departmentId | 不筛选；部门范围自动为当前部门 | UUID，大小写规范为小写                         |
| type         | all                            | all/travel/purchase/reimbursement              |
| from、to     | 无对应边界                     | 0001-01-01至9999-12-31的真实日历日期，起止有序 |

未知、重复、空字符串、非法参数均400 VALIDATION_ERROR。不支持status、page、applicantId、角色参数或custom类型；统计是汇总，不分页，也不能用status把分布缩成一个状态后冒称全部。

personal的applications只统计本人；departmentId仅筛选申请保存的部门，不能扩大本人范围。调部门后，本人仍能查询旧部门的本人历史。传入不存在的合法部门UUID返回零，不查询或透露该部门名称/存在性。

department只允许有效department_head角色查看当前确认部门，省略departmentId自动采用该部门，指定其他UUID一律403 STATISTICS_FORBIDDEN。员工调部门不会搬移旧申请的归属；负责人调部门后只可统计新部门。系统管理员、财务审批人、企业负责人没有默认部门/公司统计特权；兼任department_head时仅取得当前部门汇总。未实现额外财务或全公司统计授权，不新增授权配置。

pendingTasks在两种scope下始终只计调用者实际已激活、前序均通过、申请仍pending的当前任务；不统计部门其他人的待办。它与applications独立：本人无申请的审批人仍可能有待办。同人两节点每次只计当前节点，blocked、cancelled、已办及本人申请排除。部门/类型/时间筛选同时作用于申请和待办对应的申请。

组织72002共享锁后重验会话/active账号/有效部门及角色，等待期间撤销角色、会话或调整部门会生效。匿名、失效/停用401；待确认/部门无效403。已有管理配置权限、任务权限和统计汇总权限互相独立，部门汇总不授权读取任何未分配的正文或票据。

## 口径与返回

响应为{data:{filters,applications,pendingTasks}}，Cache-Control:no-store。filters返回实际scope、departmentId（无筛选为null）、type、from/to（无边界为null）、timeBasis:"submittedAt"、timezone:"Asia/Shanghai"。

applications包含total、statuses:{pending,approved,rejected,withdrawn}、byType。byType每项为{type,total,statuses,approvedAmount,approvedAmountMissingCount}。type=all返回三项（按类型英文名排序）；指定类型只返回该项，空结果仍有零计数。total是申请数，不是费用行数、报价数、任务数或关联数。重提新单提交后是独立申请，原已驳回/撤回记录仍保留；重提草稿不计数。

pendingTasks包含total和byType:[{type,count}]，类型选择/排序与applications相同。时间统一按对应申请submitted_at，上海from日00:00起，to次日00:00前；不是创建时间、费用发生日、任务激活日或批准日。无日期筛选表示所有提交时间；即使无日期也排除草稿。状态是查询时的当前状态，不是回溯某日的历史状态，因此日后审批会改变该提交期间的分布。

approvedAmount仅汇总当前approved：travel取冻结后不可编辑的travel_requests.budget，purchase取purchase_items.amount精确行合计（不是预算或拟选报价），reimbursement取reimbursement_items.amount精确合计。关联来源、重提链、报价和任务不参与金额连接，不重复放大。三种金额不能跨类型相加，返回中没有全业务金额总计；通过金额也不表示实际支付/到账。

金额为两位小数十进制字符串，用PostgreSQL NUMERIC合计，不转JS Number，不将多单总额强制限制回NUMERIC(14,2)。无已批准记录返回"0.00"，合法零差旅预算也是"0.00"；异常旧数据缺头/缺明细/缺金额时，所在类型approvedAmount为null，approvedAmountMissingCount明确缺失单数，不把未知当零或返回误导的部分总额。正常提交已有完整性校验，此分支是防御性读取。

## 实现与一致性

- src/lib/statistics.ts导出statisticsSchema、statisticsTypes、statisticsStatuses和StatisticsInput/StatisticsType/StatisticsCounts/FixedBusinessStatistics。
- src/server/statistics.ts导出getFixedBusinessStatistics(token:string|undefined,input:StatisticsInput):Promise<FixedBusinessStatistics>，服务再次校验输入并自行事务/鉴权。
- src/server/statistics-handlers.ts的statisticsHandler(request:Request)校验HTTP查询/凭据，src/app/api/statistics/route.ts只导出GET。
- 数量、状态、分类型金额及本人待办在一条SQL的同一快照内读取。不锁业务申请行，不阻止审批；同次返回是一致的旧或新已提交状态，跨请求可能变化，不能据统计直接审批。
- 017_fixed_statistics_indexes.sql增加按申请部门/申请人及提交时间的两个固定业务部分索引，沿用现有任务索引。不改旧迁移或业务行、执行记录、通知、附件。

## 验证与限制

18项专项覆盖三类型四状态、精确/大额/零/缺失金额、本人和部门隔离、当前角色/部门及历史正文权限、实际待办与同人两步、上海日期边界/非法参数、重提与来源关联不重计、身份和组织锁等待后重验、并发旧/新快照、只读无副作用、重复迁移和重建连接。

HTTP验收与现有列表/详情独立比对数量、状态、批准金额和实际待办，检查Cookie/Bearer、越权/非法参数和Web进程重启前后结果。专项18/18、完整379/379（24文件）和生产HTTP/Web重启已通过；开发库017追加前后20张业务表内容摘要不变，重复迁移不变。完整过程见STATUS.md和DEVELOPMENT_LOG.md。测试只用approval_test和隔离附件，开发库不重置/seed。

S4s当时仅后端；S4t已查看设计并接入统计页/图表，浏览器与截图验收见WEB_STATISTICS.md，工作台仍未开放。依赖保持用户指定版本，到S5仍停止整个项目代码修改。
