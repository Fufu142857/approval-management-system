# 企业审批系统 · B/S 课程作业

依据本地外层目录中的作业要求与设计文档分阶段开发。两份 PDF 是隐私资料，不随仓库发布；本地路径为 `../Assignment.pdf` 与 `../Design.pdf`。
已完成：**S0 仓库与需求基线、S1 工程骨架、S2 用户与组织（数据库、身份接口、Web 页面及公共外观对齐）**。**S3a–S3d 差旅审批与本人通知后端**也已完成；下一步 S3e 受控差旅附件，具体检查点见 [当前进度](docs/STATUS.md)。三类审批闭环、自定义流程与最终 Docker 部署尚未完成。

独立远程：[Fufu142857/approval-management-system](https://github.com/Fufu142857/approval-management-system)。

本地工程目录是 `B_S/approval-management-system/`，以下命令都在该子目录中执行。两份 PDF 只保留在外层 `B_S/`，不得复制进工程或提交。

## 开发资料

- [当前进度与新 Agent 接续入口（先读）](docs/STATUS.md)
- [已有 HTTP 接口、固定差旅与认证约定](docs/API.md)
- [身份管理页面、使用方法与浏览器验收](docs/WEB_IDENTITY.md)
- [界面原型依据与外观约束](docs/UI_GUIDELINES.md)
- [阶段计划与验收条件](docs/DEVELOPMENT_PLAN.md)
- [需求追踪与设计差异](docs/REQUIREMENTS.md)
- [Git 管理、上传与交付](docs/GIT_WORKFLOW.md)
- [代码风格与接口约定](docs/CONTRIBUTING.md)
- [人工模块交接约束](docs/HUMAN_HANDOFF.md)
- [真实开发记录](docs/DEVELOPMENT_LOG.md)
- [数据库初始化与本地运行](docs/DATABASE.md)

## 本地开发

建议 Node.js 24 LTS，使用 package.json 中指定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

先按 DATABASE.md 启动并初始化数据库，再访问 http://localhost:3000；地址必须与 APP_ORIGIN 一致。首页进入登录或个人信息；管理员可访问用户管理和审计页面。差旅草稿、固定提交、顺序审批、撤回与详情目前仅有 HTTP API，页面尚未接入；通知已有本人列表/详情/未读数/已读 API，尚无通知页面和前台轮询。提交需本部门恰有一名有效负责人、全组织恰有一名有效财务审批人，且均不能是申请人，详情见 API.md。新增迁移通过 `pnpm db:migrate` 应用，不需要重置或重新初始化数据库。`GET /api/health` 仍只检查 Web 进程存活。

```sh
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
pnpm test
pnpm test:http
pnpm test:e2e
```

测试前按 [数据库说明](docs/DATABASE.md) 设置独立 TEST_DATABASE_URL。`test:http` 和 `test:e2e` 需要先 build，分别在 127.0.0.1:3100/3101 启动临时生产服务并自动关闭；三组测试均可能级联清空测试库身份与业务数据，不要并行运行。首次浏览器测试执行 `pnpm exec playwright install chromium`，或使用本机 Chrome：`E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`。本机原生 PostgreSQL 已验证，Docker 引擎运行验证仍待完成。

## 开发与署名

项目由 [Fufu](https://github.com/Fufu142857) 主导，[Codex](https://github.com/codex) 提供允许范围内的 AI 编程协助。用户的设计与独立实现部分保留真实归属；协作提交使用共同作者署名，由 Codex 主要撰写的独立增量使用 Codex 作者身份。详见 [署名规则](docs/GIT_WORKFLOW.md)。

开发按可验证的功能增量提交，不要求每天固定提交，不伪造时间或补造历史。每个增量记录变化、测试结果与限制；经过验证的进度推送到远程。

## 独立实现约束

管理员自定义审批流程模块必须由学生本人完成，不能使用 AI 辅助编程。到 S5 时交接并停止代码开发，详见 [交接文档](docs/HUMAN_HANDOFF.md)。
