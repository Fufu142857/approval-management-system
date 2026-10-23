# 本作业的协作约束

开始工作前先阅读 docs/STATUS.md，再阅读 README.md、docs/DEVELOPMENT_PLAN.md、docs/DEVELOPMENT_LOG.md 和 docs/HUMAN_HANDOFF.md。每个增量必须更新 STATUS.md 的已完成/未完成、验证结果和下一步；接口变化同步 API.md，不能只在聊天里保存进度。迁移或中断恢复时先检查 Git 状态，保留未提交成果。
外层 ../Assignment.pdf 是验收依据；../Design.pdf 是用户已完成的设计。两份文件属于隐私资料，只能保留在外层 B_S，不得复制进工程、提交到 Git 或上传公开仓库。不能把规划当作已实现功能。

## 分阶段开发

- 每轮默认只推进一个可验收阶段。先验证本阶段、更新开发日志，再创建语义明确的 Git 提交，向用户说明下一阶段。
- 不得一次生成完整作业，再拆分提交伪装成逐步开发；不得伪造提交时间、测试结果或人工作者。
- 只有配置了用户指定的独立远程仓库后才能推送；不要使用父课程仓库的 origin，不做强制推送。
- 工程仓库根目录是 B_S/approval-management-system，不是 B_S。B_S 中保留用户的 PDF 原件，仓库中不保存参考副本。不得强制添加被忽略的隐私文件。
- 提交只包含本阶段文件；保留原 PDF。按用户要求使用 stage/sNN-description 等纯功能名称，分支名不得包含 Codex、AI 或其他助手标识。AI 使用情况记录在开发文档中。
- 用户要求呈现真实的 Codex 作者贡献。以用户为主作者、Codex 参与的新提交加入 `Co-authored-by: Codex <noreply@openai.com>`；主要由 Codex 编写的独立增量可使用同一身份作为提交作者，用户仍为提交人，且不重复添加自己为共同作者。不改用户 Git 配置，不邀请账号，不给用户独立实现的模块添加 AI 署名。
- 开发按真实可验证增量提交，不强行按天切分，不倒填日期或为增加提交数量制造空提交。

## 必须由用户独立实现的模块

Assignment.pdf 第 3 页、第 6 模块原文：**“本功能模块实现不能使用AI辅助编程。”**
Design.pdf 第 19 页也明确该模块独立完成。

该范围包括管理员自定义模板的创建/编辑/启停/发布、动态字段配置和渲染、节点配置/排序、审批人规则解析、发布校验、模板版本管理、自定义申请的保存/提交及相应专用迁移、测试和小程序页面。

- 不得生成、补全、修改或调试该模块实现，也不得通过通用抽象、样例、种子或伪代码提前实现它。
- 三类固定业务所需的认证、权限、附件、顺序审批执行、日志、通知可以单独开发；自定义模板的解释与发布逻辑属于人工模块。
- 到 S5 交接点，**停止整个项目的一切代码修改**，提交已有工作并完成文字交接，不趁等待继续写其他模块。
- 交接必须列出真实存在的接口/签名/路径、数据库边界、事务与权限规则、错误约定、运行命令、测试数据、代码风格、人工验收清单和准确的基线提交。
- 用户完成独立实现并明确要求恢复后，才能继续后续允许的工作；恢复后也不能代写人工模块。
- 已有接口以 docs/API.md 和实际代码为准；当前已有固定差旅草稿、提交/详情及通过/驳回/撤回操作，本人通知查询/已读接口也已实现，受控差旅附件上传/列表/删除/预览下载也已实现，S3f 已接入差旅草稿/附件/提交与只读详情页面，S3g 已有全状态申请/待办/已办列表 API，S3h 已接入对应列表与审批/撤回页面，S3i 已接入通知页面与前台轮询，S3j 已实现固定差旅复制重提及不可变来源关联（附件需重新上传），S4a 已有固定采购草稿 CRUD（多条明细/报价、精确合计与稳定行 ID），S4b 已有本人采购草稿的报价附件接口和删除一致性保护，S4c 已实现采购提交、固定“部门负责人 → 企业负责人”快照及提交后正文/附件权限，S4d 已实现采购通过/驳回/撤回及历史权限，S4e 已有采购本人全状态申请及待办/已办列表 API，S4f 已接入采购草稿与报价附件 Web 页面，S4g 已接入采购提交/只读详情和通知跳转，S4h 已接入采购全状态/任务列表及审批/撤回页面，S4i 已接入采购复制重提及不可变来源（明细/报价新行 ID，附件需重传），S4j 已有固定报销本人草稿 CRUD、费用明细精确合计与本人已批采购/差旅关联，S4k 已有报销草稿票据上传/列表/受控内容/删除与明细/整单删除保护，S4l 已有报销提交完整校验、固定部门/财务快照、提交后详情/票据授权和首节点通知，S4m 已有报销通过/驳回/本人撤回及终态通知与历史权限，S4n 已有报销本人全状态申请及待办/已办列表 API，S4o 已接入报销草稿与票据 Web 页面，报销提交/详情与列表审批页面、重提尚未实现；禁止向用户声称可直接调用未实现的能力。

## 实现规范

遵守 docs/CONTRIBUTING.md。技术栈保持 Next.js 16 / React 19 / TypeScript / Tailwind CSS 4 / PostgreSQL；微信小程序独立使用 WXML / WXSS / TypeScript，并复用 HTTP API。
权限在服务端执行，禁止客户端控制申请人/部门/角色/实际审批人。金额使用精确计算，业务状态、待办、审批日志及通知在同一事务内更新。

## 界面外观约束

用户要求 UI 外观与外层 Design.pdf 完全一致，不能自行另做视觉主题。修改界面前阅读 docs/UI_GUIDELINES.md，并渲染、查看原件中对应原型，完成后检查真实浏览器截图；只读 PDF 提取文本不足以确认外观。公共框架沿用黑白灰、四格标志、左侧导航、内容顶部标题和用户菜单、浅灰底与白色卡片。已有具体原型的页面按其结构、间距、字号、图标和控件逐项对照；没有独立原型的页面沿用公共规范并如实记录，不得宣称已逐像素一致。

不复制或提交 PDF、原型提取图片与私密截图；迁移时由用户私下提供原件。原型中的示例业务和数字不代表已实现能力；未完成入口保持不可用，不用假数据填充工作台。设计参考不改变 S5 人工模块边界。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
