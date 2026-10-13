# 企业审批系统 · B/S 课程作业

依据 [Assignment.pdf](Assignment.pdf) 与 [Design.pdf](Design.pdf) 分阶段开发。
当前轮次：**S0 仓库与需求基线 + S1 工程骨架**。尚未实现登录、数据库、三类审批或自定义流程。

## 开发资料

- [阶段计划与验收条件](docs/DEVELOPMENT_PLAN.md)
- [需求追踪与设计差异](docs/REQUIREMENTS.md)
- [Git 管理、上传与交付](docs/GIT_WORKFLOW.md)
- [代码风格与接口约定](docs/CONTRIBUTING.md)
- [人工模块交接约束](docs/HUMAN_HANDOFF.md)
- [真实开发记录](docs/DEVELOPMENT_LOG.md)

## 本地开发

建议 Node.js 24 LTS，使用 package.json 中指定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 http://localhost:3000。当前首页仅确认工程可启动，`GET /api/health` 仅检查 Web 进程存活，不能代表数据库或业务可用。

```sh
pnpm lint
pnpm typecheck
pnpm format:check
pnpm build
```

S2 起加入 PostgreSQL 迁移、初始化数据、认证、权限及有意义的 Vitest 测试。Docker Compose 随 S2 基础服务接入，最终独立环境重建在 S8 验收。

## 独立实现约束

管理员自定义审批流程模块必须由学生本人完成，不能使用 AI 辅助编程。到 S5 时交接并停止代码开发，详见 [交接文档](docs/HUMAN_HANDOFF.md)。
