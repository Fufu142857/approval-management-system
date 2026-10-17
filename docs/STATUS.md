# 当前进度与接续入口

本文件是新 Agent 的第一阅读入口。每个开发增量结束前更新本文件与 DEVELOPMENT_LOG.md；阶段或接口变化时同步 DEVELOPMENT_PLAN.md、API.md 和 HUMAN_HANDOFF.md。不能只把进度保存在聊天中。

## 当前检查点

- 已验收：S0、S1、S2a–S2d、S3a；本轮开始时的已提交基线为 `a23216d`。S2 身份与组织完成；S3 仅完成差旅草稿后端，尚无提交审批能力。
- 当前检查点：S3a 固定差旅数据模型、草稿接口和校验，阶段分支 `stage/s03a-travel-drafts`。准确提交用 `git log -1 --format='%h %s' -- docs/STATUS.md` 查询；本地未提交时以 `git status` 为准。
- 本轮范围：002 迁移、本人草稿创建/列表/详情/完整保存/删除、精确预算与自然日计算、身份与所有权控制、版本冲突、事务回滚和真实 HTTP 重启持久化验收。接口见 [API.md](API.md)，数据库边界见 [DATABASE.md](DATABASE.md)。
- 下一增量：S3b 固定差旅提交及审批基础。先复核固定审批人的确定规则与失败处理，再分步实现完整提交校验、固定路径/人员快照、首个待办和通知的一致性；后续增量继续通过/驳回/撤回、附件与页面，不一次完成整个 S3。
- 尚未实现：差旅草稿页面、提交与审批、采购/报销、附件、通知、统计、自定义流程、小程序和 OCR。既有 UI 不变，业务导航仍不可用；后续页面继续按 [UI_GUIDELINES.md](UI_GUIDELINES.md) 和外层原型对照。

## 接续顺序

1. 阅读根目录 AGENTS.md、本文件、DEVELOPMENT_LOG.md、HUMAN_HANDOFF.md、CONTRIBUTING.md；按需读 API.md 和 DATABASE.md；修改界面前读 UI_GUIDELINES.md 并查看外层设计原型。
2. 在工程子目录运行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，确认未提交工作及真实基线。未提交文件可能是上一轮中断成果，不得直接覆盖或清理。
3. 检查本地 `.env` 是否存在及数据库是否启动，不输出任何密码。迁移机器时按 DATABASE.md 重新创建环境；`.env`、数据库数据和 `tmp/` 不会随 Git 迁移。
4. 完成当前未验证增量，再推进下一阶段。每个增量更新进度、执行对应检查、真实提交并推送；不伪造提交日期，不制造空提交。

## 验证与环境

S3a 已通过 31 项真实数据库/接口测试（原有 16 项 + 草稿 15 项），以及真实 HTTP 身份与草稿闭环、生产进程重启后会话/草稿保留验证、lint、类型/格式检查、生产构建和差异检查。具体命令及记录见 DEVELOPMENT_LOG.md。

常用命令：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`；构建后运行 `pnpm test:http`。有界面改动时另运行 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`。所有集成测试都可能级联清空身份和申请数据，**仅允许使用独立、名称以 `_test` 结尾的 TEST_DATABASE_URL**，不得指向开发或交付数据库，也不要并行运行数据库、HTTP、浏览器测试。

本轮只改后端和测试，未重跑 UI 浏览器测试；S2d 已通过 5 组 Chrome 场景并检查 8 张桌面/390×844 截图。尚未覆盖 Safari、Firefox、手机真机。公开 HTTPS、入口流量限制和 Docker 重建仍待部署阶段验收。资料修改、密码重置、部门增删改尚未实现。

编号取舍已落定：首次创建草稿分配非空唯一 APP-序号，未来提交沿用；回滚/删除可产生空号。日期采用上海日历日期、首尾均计入，不记录日内时刻。草稿可缺字段，保存通过不代表提交校验通过；PUT 是完整替换，省略字段会清空，必须携带 version，详见 API.md。

S2c 的自定外观已由 S2d 纠正；当前身份页没有各自独立原型，只沿用公共视觉框架，不宣称逐像素一致。S5 停止全项目代码修改的边界继续有效。

本机 PostgreSQL 17 项目实例使用 `tmp/pgdata`、127.0.0.1:55432；数据库为 approval 与 approval_test。不要重新初始化已有集群或覆盖 `.env`；不要使用其他课程或系统默认数据库。数据库本地原生运行已验收，Docker 引擎尚未运行验证。

## 持续有效的约束

- 工程根是 B_S/approval-management-system；公开远程是 Fufu142857/approval-management-system。父课程仓库保持独立，不推送或重写它。
- Assignment.pdf、Design.pdf 只能留在外层 B_S，不能复制、提交或上传；迁移机器时由用户私下提供外层原件。旧公开 PDF 缓存清除申请只准备未提交，文件位于忽略的 `tmp/github-support-request.md`；用户选择保持仓库公开。
- UI 必须以外层 Design.pdf 为依据，不能自行更换主题；每次界面改动检查真实浏览器截图并记录未覆盖部分，详见 UI_GUIDELINES.md。
- 分支名不得出现 Codex、AI 等助手标识；贡献署名遵循 AGENTS.md，不改用户 Git 身份。
- S5 自定义流程必须由用户独立实现；到达 S5 时停止**整个项目**所有代码修改并提供完整文字交接。任何后续阶段也不能代写或调试人工模块。
