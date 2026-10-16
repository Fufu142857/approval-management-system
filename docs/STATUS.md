# 当前进度与接续入口

本文件是新 Agent 的第一阅读入口。每个开发增量结束前更新本文件与 DEVELOPMENT_LOG.md；阶段或接口变化时同步 DEVELOPMENT_PLAN.md、API.md 和 HUMAN_HANDOFF.md。不能只把进度保存在聊天中。

## 当前检查点

- 已验收：S0、S1、S2a、S2b、S2c、S2d；本轮开始时的已提交基线为 `868d66c`。S2 身份与组织功能已完成；Docker 运行仍未验收。
- 当前检查点：S2d 公共界面与设计原型对齐，阶段分支 `stage/s02d-design-alignment`。本检查点的准确提交使用 `git log -1 --format='%h %s' -- docs/STATUS.md` 查询，避免提交在自身文件中引用自身哈希；本地未提交时以 `git status` 为准。
- 本轮范围：纠正 S2c 的自定主题，按外层设计原型重做黑白灰公共外壳、四格标志、左侧导航、内容顶栏、用户菜单、卡片和控件；同步浏览器交互验收与持久化设计约束。接口仍沿用 S2b，见 [API.md](API.md)；页面与测试见 [WEB_IDENTITY.md](WEB_IDENTITY.md)，外观约束见 [UI_GUIDELINES.md](UI_GUIDELINES.md)。
- 下一增量：S3a 固定差旅的数据模型、草稿接口和校验。先复核外层设计中的差旅字段、金额/日期规则、编号分配时机，再实现一个可验证增量；后续逐步接入提交、固定顺序审批、附件和通知，不一次完成整个 S3，更不能加入动态模板解释器。
- 尚未开始：三类固定审批、附件、通知、统计、自定义流程、小程序和 OCR。

## 接续顺序

1. 阅读根目录 AGENTS.md、本文件、DEVELOPMENT_LOG.md、HUMAN_HANDOFF.md、CONTRIBUTING.md；按需读 API.md 和 DATABASE.md；修改界面前读 UI_GUIDELINES.md 并查看外层设计原型。
2. 在工程子目录运行 `git status --short`、`git branch --show-current`、`git log -5 --oneline`，确认未提交工作及真实基线。未提交文件可能是上一轮中断成果，不得直接覆盖或清理。
3. 检查本地 `.env` 是否存在及数据库是否启动，不输出任何密码。迁移机器时按 DATABASE.md 重新创建环境；`.env`、数据库数据和 `tmp/` 不会随 Git 迁移。
4. 完成当前未验证增量，再推进下一阶段。每个增量更新进度、执行对应检查、真实提交并推送；不伪造提交日期，不制造空提交。

## 验证与环境

S2c 已通过 16 项数据库/身份测试、5 组真实浏览器场景、真实 HTTP 闭环、lint、类型/格式检查和生产构建；具体记录见 DEVELOPMENT_LOG.md。常用命令：`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`；构建后依次运行 `pnpm test:http`、`pnpm test:e2e`。本机浏览器命令为 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`，其他机器可安装 Playwright Chromium。三类集成测试均会清空身份数据，**仅允许使用独立、名称以 `_test` 结尾的 TEST_DATABASE_URL**，不得指向开发或交付数据库，也不要并行运行。

S2d 重新通过 5 组浏览器场景、lint、类型/格式检查和生产构建；本轮未改后端或迁移，没有重复执行 S2c 的 16 项后端测试和 HTTP 测试。已检查 8 张桌面与 390×844 手机视口截图；尚未覆盖其他浏览器或手机真机。首页按会话跳转登录或个人信息。公开部署的 HTTPS、入口流量限制和 Docker 重建仍在后续部署阶段验收。资料修改、密码重置、部门增删改不是当前已提供功能。

S2c 的功能验收不代表其自定配色符合原型，S2d 已纠正。当前身份页没有各自独立原型，沿用设计的公共视觉框架，不宣称逐像素一致；工作台、申请、待办、通知与搜索尚未实现，入口不可用。后续具体业务页面须继续按原型验收。

本机 PostgreSQL 17 项目实例使用 `tmp/pgdata`、127.0.0.1:55432；数据库为 approval 与 approval_test。不要重新初始化已有集群或覆盖 `.env`；不要使用其他课程或系统默认数据库。数据库本地原生运行已验收，Docker 引擎尚未运行验证。

## 持续有效的约束

- 工程根是 B_S/approval-management-system；公开远程是 Fufu142857/approval-management-system。父课程仓库保持独立，不推送或重写它。
- Assignment.pdf、Design.pdf 只能留在外层 B_S，不能复制、提交或上传；迁移机器时由用户私下提供外层原件。旧公开 PDF 缓存清除申请只准备未提交，文件位于忽略的 `tmp/github-support-request.md`；用户选择保持仓库公开。
- UI 必须以外层 Design.pdf 为依据，不能自行更换主题；每次界面改动检查真实浏览器截图并记录未覆盖部分，详见 UI_GUIDELINES.md。
- 分支名不得出现 Codex、AI 等助手标识；贡献署名遵循 AGENTS.md，不改用户 Git 身份。
- S5 自定义流程必须由用户独立实现；到达 S5 时停止**整个项目**所有代码修改并提供完整文字交接。任何后续阶段也不能代写或调试人工模块。
