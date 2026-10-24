# S4p 固定报销提交与只读详情

本阶段接入现有 S4l/S4m 服务，不增加 HTTP 接口或迁移，数据库仍为015。草稿见 WEB_REIMBURSEMENT.md；提交规则见 REIMBURSEMENT_SUBMISSION.md；动作后端见 REIMBURSEMENT_ACTIONS.md。S4q已另行接入报销全状态/任务列表与审批操作页面，见WEB_REIMBURSEMENT_APPROVAL.md，复制重提和统计继续分步，到 S5 停止全项目代码修改。

## 提交与失败恢复

草稿编辑器开放“提交申请”：先用 reimbursementDraftSchema 规范化，再调用 reimbursementSubmissionIssues 检查标题/说明、独立理由、完整费用及每行自己的票据或显式无票原因。其他费用的票据不能替代本行；有文件的无票项目仍保留声明和原因。前端只检查固定字段和附件元数据，服务端仍重验身份、来源资格、原文件完整性、精确金额及实际审批人。

确认框显示申请、精确总额、无票项数、关联来源或独立说明，以及“部门负责人 → 财务审批人”。取消不写入；确认后先 POST/PUT 保存当前输入，成功才以返回的最新 version 调用提交接口。未改动的已有草稿沿用当前已保存版本；新单可直接保存后提交。票据必须先完成上传；只填票据号码不会新增文件。同步写锁与禁用控件防止重复提交，成功进入 /reimbursement/applications/:id。

保存响应丢失不得继续提交；提交响应丢失、版本冲突、非草稿等结果不确定时保留当前输入、停写、不自动重放。可在新窗口核对服务器草稿或提交后详情，确认后才丢弃本地修改重载。已知字段/审批配置错误展示原始服务端原因，保存成功也不能称为提交成功。旧草稿入口若已提交，不能编辑，提供受控详情链接；无权详情仍由原接口拒绝。

## 冻结详情与票据

新增 /reimbursement/applications/:id，服务端检查有效业务身份和 UUID，客户端分别请求已提交正文与附件。两个 GET 的 version/status 必须匹配；任一失败或不一致隐藏正文并允许手动重新读取，不显示旧详情或假空文件。

详情显示申请编号/状态/提交时间、冻结申请人/部门、报销说明、精确总额、费用类型/日期/用途/金额、逐行票据与号码、备注、实际审批人员/进度及历史意见。无票项数在顶部突出，费用行与票据分组显示原因；另有文件也不隐去无票声明。金额沿用服务器精确字符串，不经浮点重算。

关联区域只使用 routeSnapshot.linkedApplications 中提交时冻结的必要摘要：差旅行程/日期/预算、采购预算/总额，以及来源编号/标题/提交时间。独立说明也从快照显示。没有实时获取源全文、附件或提供来源跳转，报销审批权限不能扩大源单权限。

逐项 JPEG/PNG 预览、PDF.js 翻页与下载使用 reimbursement-applications 专用鉴权路径，下载保留原字节，号码为空如实显示。失败可再次发起明确的只读请求，不把文件不可读解释为没有票据。没有上传/删除/修改/重提控件；S4q已另行按实际节点/本人权限开放审批/撤回。通过、驳回、撤回后刷新仍可显示冻结内容和历史；取消节点区分曾激活与未开始，并显示取消时间。本人及曾激活实际人员的权限由服务端控制，未激活财务、管理员和他人没有额外权限。

## 通知与真实签名

NotificationDetailPanel 的固定详情映射增加 reimbursement，仍只用已授权 target.type/id，不将 apiPath 当导航 URL；target 不可读或通知请求失败时不开放跳转。读取通知/跳转不自动标记已读，每次进入详情/文件重新鉴权，旧通知不赋予动作权限。

src/lib/reimbursement-display.ts 新增 ReimbursementDetail HTTP 展示类型，明确固定申请、routeSnapshot、tasks、logs；不引入动态字段解释器或客户端服务端模块依赖。ReimbursementDetail({id:string,viewerId:string})（S4q增加服务端身份） 在 src/components/reimbursement-detail.tsx，路由页面调用 requireBusinessPageUser。ReimbursementEditor 原签名不变，validate(complete) 调用已有固定校验；AttachmentItems 的 resource 联合增加固定 reimbursement-applications。

## 外观与验证边界

复核外层设计第7/8页公共框架/分区表单与第10页报销和详情说明。报销详情与提交确认没有独立专图，沿用黑白灰侧栏、顶栏、白卡片、只读信息和审批时间线，不宣称逐像素一致。手机单列、费用宽表仅在容器内滚动。

tests/e2e/reimbursement-submission.spec.ts 验证完整字段/逐行票据、取消确认/先保存后提交、三种文件/原字节/预览失败恢复、手机新建、保存与提交响应丢失、版本竞争/真实自审拒绝、来源权限隔离、通知跳转、读取失败/版本状态不一致，以及三种终态历史。实际执行结果见 STATUS.md / DEVELOPMENT_LOG.md；截图仅在忽略的 tmp/screenshots/reimbursement-submission-*.png，私有 PDF 与原型渲染不进入 Git。未覆盖 Safari/Firefox、手机真机、公开 HTTPS 或 Docker；不是小程序验收。
