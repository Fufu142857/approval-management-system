# 当前进度与接续入口

本文件是新 Agent 的第一阅读入口。每个开发增量结束前更新本文件与 DEVELOPMENT_LOG.md；阶段或接口变化时同步 DEVELOPMENT_PLAN.md、API.md 和 HUMAN_HANDOFF.md。不能只把进度保存在聊天中。

## 当前检查点

- 已验收：S0、S1、S2a、S2b；本轮开始时的已提交基线为 `534b5a3`。S2 整体尚未完成。
- 当前检查点：S2b 认证和管理权限后端，阶段分支 `stage/s02b-auth`。本检查点的准确提交使用 `git log -1 --format='%h %s' -- docs/STATUS.md` 查询，避免提交在自身文件中引用自身哈希；本地未提交时以 `git status` 为准。
- 本轮范围：注册、用户名登录、Cookie/Bearer 会话、退出、个人资料查询、部门/角色字典、管理员用户分页、确认部门/授权/禁用、审计分页。接口契约见 [API.md](API.md)。
- 下一增量：S2c 注册/登录/待确认/个人信息页面和管理员用户/审计页面，复用本轮接口与校验；补齐浏览器操作验收后才能宣布 S2 完成。
- 尚未开始：三类固定审批、附件、通知、统计、自定义流程、小程序和 OCR。

## 接续顺序

1. 阅读根目录 AGENTS.md、本文件、DEVELOPMENT_LOG.md、HUMAN_HANDOFF.md、CONTRIBUTING.md；按需读 API.md 和 DATABASE.md。
2. 在工程子目录运行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，确认未提交工作及真实基线。未提交文件可能是上一轮中断成果，不得直接覆盖或清理。
3. 检查本地 `.env` 是否存在及数据库是否启动，不输出任何密码。迁移机器时按 DATABASE.md 重新创建环境；`.env`、数据库数据和 `tmp/` 不会随 Git 迁移。
4. 完成当前未验证增量，再推进下一阶段。每个增量更新进度、执行对应检查、真实提交并推送；不伪造提交日期，不制造空提交。

## 验证与环境

S2b 的 16 项数据库/身份接口测试、lint、类型/格式检查、生产构建和真实 HTTP 身份闭环已通过；具体记录见 DEVELOPMENT_LOG.md。常用命令：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`；构建后运行 `pnpm test:http` 验证真实 HTTP。两类集成测试均会清空身份数据，**仅允许使用独立、名称以 `_test` 结尾的 TEST_DATABASE_URL**，不得指向开发或交付数据库，也不要并行运行这两组测试。

待下一轮完成：S2c 页面接入、浏览器交互和移动布局验收。本轮没有浏览器页面验收，首页仍是工程骨架；HTTP 通过不能等同于 UI 完成。公开部署的 HTTPS、入口流量限制和 Docker 重建仍在后续部署阶段验收。

本机 PostgreSQL 17 项目实例使用 `tmp/pgdata`、127.0.0.1:55432；数据库为 approval 与 approval_test。不要重新初始化已有集群或覆盖 `.env`；不要使用其他课程或系统默认数据库。数据库本地原生运行已验收，Docker 引擎尚未运行验证。

## 持续有效的约束

- 工程根是 B_S/approval-management-system；公开远程是 Fufu142857/approval-management-system。父课程仓库保持独立，不推送或重写它。
- Assignment.pdf、Design.pdf 只能留在外层 B_S，不能复制、提交或上传；迁移机器时由用户私下提供外层原件。旧公开 PDF 缓存清除申请只准备未提交，文件位于忽略的 `tmp/github-support-request.md`；用户选择保持仓库公开。
- 分支名不得出现 Codex、AI 等助手标识；贡献署名遵循 AGENTS.md，不改用户 Git 身份。
- S5 自定义流程必须由用户独立实现；到达 S5 时停止**整个项目**所有代码修改并提供完整文字交接。任何后续阶段也不能代写或调试人工模块。
