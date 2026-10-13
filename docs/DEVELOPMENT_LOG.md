# 开发记录

记录真实日期、阶段范围、验证与限制。阶段提交 ID 以 `git log` 为准，避免把包含本文件的提交哈希写进自身。

## 2026-10-13 · S0 仓库与需求基线

- 来源：用户提供 Assignment.pdf（6 页）和原创 Design.pdf（22 页）。设计 PDF 文本编码异常，已渲染并查看业务、原型、数据结构、流程及技术计划页面。
- 建立 B_S 独立 Git 仓库。父仓库增加 /B_S/ 忽略规则并解除 Assignment.pdf 跟踪，原文件和父仓库历史保留；父仓库隔离提交为 62970e0，未 push。
- 整理需求、分阶段计划、代码风格、Git 工作方式；以 AGENTS.md 和交接文档固化人工模块边界。
- 远程：尚未获得独立远程地址，暂时仅本地提交。
- AI 协助：仓库整理和本轮 Markdown 文档；两份原始 PDF 未修改。自定义流程实现未开始。

## 2026-10-13 · S1 工程骨架（已完成）

- 范围：Next.js 16.4.0 / React 19.3.0 / TypeScript 5.9.3 / Tailwind 4.3.3，最小启动页面和进程存活接口，格式/lint/类型/构建检查；依赖版本和 pnpm-lock.yaml 固定。
- 尚未实现：数据库、认证、业务审批、自定义流程、附件、小程序、OCR、最终 Docker 部署。
- 验证：`pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build` 均通过；生产服务监听 127.0.0.1:3100，首页 HTTP 200 且包含中文标题/阶段说明，`GET /api/health` 返回文档规定的 JSON 和 `Cache-Control: no-store`。
- 复现检查：`pnpm install --frozen-lockfile --offline` 通过（本机已有依赖缓存），确认 package.json 与锁文件一致；这不代表已在空白机器离线安装成功。
- 修正记录：ESLint 要求 PostCSS 配置先赋值后默认导出，已修正。初次 Turbopack 构建因沙箱禁止辅助端口失败，在获准的本机环境构建通过；没有用改变构建器来掩盖问题。
- 验证范围：没有数据库和业务自动测试，也未宣称通过这些测试；Vitest 随 S2 实际业务引入。本轮未做浏览器视觉或手机适配验收。
- Git：需求基线 `3ed5bdc` 已推送到用户指定远程 `main`；S1 分支按用户要求改名为 `stage/s01-foundation`。阶段验收后保留此分支并快进合并至 main，推送结果以远程引用核对为准。
- 环境观察：系统 Node.js 26.4.0、pnpm 11.16.0；当前没有可用的 docker 命令。
- AI 协助：本阶段工程配置、启动页、存活接口及开发文档。未实现人工模块，也未实现任何业务流程。
- 下一阶段：S2 PostgreSQL、部署基础、用户认证、部门/角色权限及管理员审计。到 S5 前补齐实际公共接口交接包，进入 S5 后停止全部代码修改。

## 2026-10-13 · 目录与分支约定纠正

- 用户明确要求在 B_S 下新建工程文件夹，不能直接把 B_S 当作作业仓库。已把整个工程、未提交 S1 工作和 .git 迁到 B_S/approval-management-system；保留 B_S 中两份原 PDF，工程内保留版本化副本。
- 父仓库忽略规则已缩小到 /B_S/approval-management-system/，原 Assignment.pdf 恢复跟踪，纠正提交为 745e30f；用户其他课程文件未改动。
- 开发分支改为 stage/s01-foundation。纠正时远程只有 main，没有需删除的旧开发分支。此后分支名称使用阶段/功能名称，AI 使用声明仍在开发文档中保留。
- 迁移验证：新路径删除旧构建缓存后 `pnpm build`（含类型检查）通过，`pnpm format:check` 与 `git diff --check` 通过；两份参考副本的 SHA-256 均与 B_S 原件一致。父仓库只显示原先未跟踪的 Design.pdf 和 TCS_25.pdf。
