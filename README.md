# 企业审批系统 · B/S 课程作业

依据本地外层目录中的作业要求与设计文档分阶段开发。两份 PDF 是隐私资料，不随仓库发布；本地路径为 `../Assignment.pdf` 与 `../Design.pdf`。
已完成：**S0 仓库与需求基线、S1 工程骨架、S2 用户与组织（数据库、身份接口、Web 页面及公共外观对齐）**。**S3 固定差旅闭环（S3a–S3j），含草稿、附件、审批/撤回、通知与复制重提**也已完成；S4a 固定采购数据模型与草稿后端也已完成；S4b 固定采购报价附件后端已完成；下一步 S4c 固定采购提交与提交后详情，具体检查点见 [当前进度](docs/STATUS.md)。三类审批闭环、自定义流程与最终 Docker 部署尚未完成。

独立远程：[Fufu142857/approval-management-system](https://github.com/Fufu142857/approval-management-system)。

本地工程目录是 `B_S/approval-management-system/`，以下命令都在该子目录中执行。两份 PDF 只保留在外层 `B_S/`，不得复制进工程或提交。

## 开发资料

- [当前进度与新 Agent 接续入口（先读）](docs/STATUS.md)
- [已有 HTTP 接口、固定差旅与认证约定](docs/API.md)
- [身份管理页面、使用方法与浏览器验收](docs/WEB_IDENTITY.md)
- [差旅草稿、附件、提交与只读详情页面](docs/WEB_TRAVEL.md)
- [差旅全状态列表、待办/已办与审批页面](docs/WEB_TRAVEL_APPROVAL.md)
- [通知页面、未读数与前台轮询](docs/WEB_NOTIFICATIONS.md)
- [差旅复制重提、原申请关联与附件规则](docs/WEB_TRAVEL_RESUBMISSION.md)
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

先按 DATABASE.md 启动并初始化数据库，再访问 http://localhost:3000；地址必须与 APP_ORIGIN 一致。首页进入登录或个人信息；管理员可访问用户管理和审计页面。左侧“我的申请”已接入本人全状态差旅列表与草稿管理；“我的待办”包含待办/已办。新建、附件、提交、详情及权限内的通过/驳回/撤回已接入；本人已驳回/已撤回申请可复制为关联新草稿，附件留在原单并需重新上传；通知已有本人列表/详情/未读数/已读 API，已接入通知列表/详情、显式标记已读、申请跳转与可见页面 30 秒轮询。提交需本部门恰有一名有效负责人、全组织恰有一名有效财务审批人，且均不能是申请人，详情见 API.md。新增迁移通过 `pnpm db:migrate` 应用，不需要重置或重新初始化数据库。`GET /api/health` 仍只检查 Web 进程存活。

S4a 新增 /api/purchase-drafts 本人草稿 CRUD，支持多条明细/报价、稳定行 ID、精确金额与版本控制。S4b 已提供报价附件上传/列表/预览下载/删除；采购页面、提交/审批尚未接入；草稿保存允许未填完，完整比价/单一来源规则会在提交阶段验证。开发库迁移当前为 010，详见 API.md 与 DATABASE.md。

S3e 附件 API 已由 S3f 差旅页面接入，图片与 PDF 可预览、下载。PDF.js worker/字体等公开库资源由 dev/build 自动生成在忽略的 public/vendor/pdfjs 中，不依赖 CDN；Node 至少 22.13，建议 24 LTS。默认存储于忽略的 `uploads/attachments/`，可用 ATTACHMENT_STORAGE_DIR 指定私有目录（禁止 public）；迁移机器必须配对备份/恢复数据库与附件文件。`pnpm attachments:gc` 只回收当前数据库未引用的附件对象，运行前确认数据库与目录属于同一环境；详情见 DATABASE.md。

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
