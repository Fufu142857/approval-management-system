# S4r 固定报销复制重提

本人已驳回/已撤回报销详情提供“复制修改后重新提交”。先确认编号/标题、复制范围、票据规则和来源资格，取消或Escape不写入；确认只发送原申请最新version。草稿/审批中/已通过及其他人员没有入口，API独立检查身份与所有权。

复制标题、报销说明、独立说明、备注、费用顺序/分类/日期/用途/精确金额、显式无票标记及原因，并保留仍有效的本人已批采购/差旅关联。新申请使用新编号、当前确认部门、version=1、提交时间null，费用使用新行ID；resubmissionOf固定指向原报销。此关联和application_links中的采购/差旅来源是不同含义。

票据记录、号码、文件对象、旧审批人员/任务/日志/通知不复制。原正文、费用、冻结来源、无票例外、历史和原票据保持。新草稿提示按费用重新上传；原先未声明无票的行仍需新票据或显式填写新的无票例外，系统不会自动改成无票。新单保存/提交继续走已有固定报销完整校验，重新确认关联资格、真实文件及当前部门/财务人员。

## 唯一后续与恢复

同源并发复制返回同一个直接后续，重复请求不覆盖用户编辑、附件或当前状态。删除尚未提交的后续草稿后可重建；已提交后续不可覆盖，它再次驳回/撤回时从它继续形成链。成功后显示“编辑重提草稿”或“查看后续申请”；本人在新草稿/提交详情可“查看原申请”。新旧申请分别授权，旧审批人不会因此获得新单，新审批人也不会获得旧单。

失败或结果未知暂停写入，先点“核对复制结果”只发GET，找回实际后续；版本冲突须刷新整份详情后再确认。没有自动重放POST或自动提交。读取失败不出现可写入口；复制期间禁用重复确认、详情刷新和附件按钮，刷新/关闭窗口提示处理中。停止浏览器等待不代表服务器撤销写入。

首次复制会在事务内按UUID顺序锁定并重新核验关联来源的本人身份、travel/purchase类型及approved状态，失败返回LINK_NOT_AVAILABLE并不创建草稿，不静默删除关联。原终态详情仍使用原提交时冻结摘要。已有后续只返回标识/状态/版本，不重新复制内容；后续草稿读取、保存及提交继续各自校验关联。

## 实现与数据库

- src/server/reimbursement-resubmission.ts导出getReimbursementResubmission(token,id)与copyReimbursementForResubmission(token,id,version)，自行开事务；调用前校验UUID/version。
- reimbursement-resubmission-handlers.ts及/api/reimbursement-applications/:id/resubmission提供GET/POST，具体响应/错误见API.md。
- ReimbursementDraft/ReimbursementRecord新增只读resubmissionOf:string|null，普通草稿schema不接受这个字段。ReimbursementResubmission/Result/Successor类型在src/lib/reimbursement-resubmission.ts。
- reimbursement-resubmission-panel.tsx负责固定确认/关系查询/恢复，detail/editor提供权限入口和票据重传/来源链接。复用既有对话框和黑白灰样式，无动态字段/模板/规则解释器。
- 016_reimbursement_resubmission.sql只扩展既有不可变重提触发器到第三类固定业务，保留差旅/采购来源。沿用唯一后续、自引用检查及外键；不修改旧迁移、历史或文件。

事务锁顺序为组织/身份/部门 → 原报销FOR UPDATE（GET为SHARE）→ 已有后续SHARE，或按UUID排序的采购/差旅来源SHARE → 新草稿/费用/链接。同源复制在原单串行，原单version/时间/执行历史不变。首次复制通过readReimbursementDetail(client,id)的实时来源核验分支，仅在已验证本人且持原单锁的复制服务调用；审批及普通提交后详情仍传冻结摘要，不扩权读取实时源单。

## 验证与外观

新增tests/reimbursement-resubmission.test.ts覆盖字段/精确金额/新行ID、终态/权限/严格输入与Origin、版本、并发复用、删除重建/链延长、数据库约束、多表故障回滚、当前部门和重新解析人员、关联采购/差旅资格、票据重传与原字节、等组织锁后会话重验、重复迁移/重连。

新增四组Chrome场景覆盖确认取消、编辑/重传/提交及双向链接、并发双窗口与旧审批人无入口、响应丢失GET核对、删除重建、读取失败和版本冲突。生产HTTP加入真实复制/编辑/关联/票据重传/新执行与Web重启后新旧详情、来源及文件字节核对。专项22/22、完整361/361项（23文件）、Chrome专项4/4及完整77/77、生产HTTP/Web重启均通过；开发库016追加前后20张业务表行数和内容摘要不变，重复迁移不变。具体过程见STATUS.md和DEVELOPMENT_LOG.md，数据库/浏览器/HTTP串行使用独立approval_test和隔离附件目录。

设计第7页公共框架、第10页报销和申请说明为依据，无独立重提原型，不声称逐像素一致。截图仅存忽略的tmp/screenshots/reimbursement-resubmission-*.png，原PDF和提取图不入Git。Safari/Firefox、真机、公开HTTPS、Docker不在本轮验收范围。依赖按用户决定保持原版本；后续统计单独推进，到S5停止整个项目代码修改。
