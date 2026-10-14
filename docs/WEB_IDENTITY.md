# S2 身份管理页面与验收

已实现注册、登录、退出、待确认提示、个人资料、管理员用户管理与操作审计。个人资料当前只读；没有密码重置、资料自行修改或部门增删改入口。所有账号均使用真实 PostgreSQL 数据，页面不内置开发账号或密码。

## 本地使用

按 DATABASE.md 启动数据库并完成初始化后，运行 `pnpm dev`，访问 http://localhost:3000。浏览器访问的协议、主机和端口必须与 `.env` 的 APP_ORIGIN 完全一致；localhost 与 127.0.0.1 不能混用。更改环境配置后重启 Web 服务。

| 页面         | 行为                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ |
| /            | 根据服务端会话跳转登录或个人信息                                                                 |
| /register    | 用户名、姓名、邮箱、密码和申请部门；前端共享后端 schema，成功后提示前往登录                      |
| /login       | 用户名/密码登录；错误与会话失效提示；已登录时跳转个人信息                                        |
| /account     | 个人资料、申请/确认部门、状态和角色；pending 显示待确认及刷新按钮                                |
| /admin/users | 仅 active system_admin；状态筛选、每页 10 人、确认部门、角色和账号状态、必填原因、变更预览及确认 |
| /admin/audit | 仅 active system_admin；每页 10 条，只读原因、变更前后快照与操作者/目标 ID，上海时区时间         |

管理员使用本机 `.env` 的 ADMIN_INITIAL_PASSWORD 登录 admin。建议用另一个浏览器或独立隐私窗口注册员工；管理员确认或修改权限后，员工原有会话失效，需重新登录。管理员不能修改自己的部门/状态/角色。普通员工直接输入管理页面地址也会被服务端拒绝，不只隐藏导航。

页面通过同源 Cookie 调用现有 API，不读取令牌、不将令牌放入 localStorage。受保护页面在服务端校验会话；客户端在进入工作空间、窗口重新聚焦、pageshow 和每 60 秒检查会话，失效时返回登录。管理 API 的 401/403 同样处理；权限变更的最终判断仍在后端。页面交互依赖 JavaScript；未加载脚本时表单使用 POST，避免密码进入 URL。

## 可重复运行的浏览器验收

先设置独立 TEST_DATABASE_URL，按顺序执行；**以下测试都可能清空测试库，三组测试不得并行执行，不得将测试地址指向开发库**。

```sh
pnpm test
pnpm build
pnpm test:http
pnpm exec playwright install chromium
pnpm test:e2e
```

已有本机 Chrome 时，可省略下载 Chromium，使用：

```sh
E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```

Playwright 在 127.0.0.1:3101 启动生产服务，并使用测试库、测试专用 APP_ORIGIN；不会复用已占用该端口的服务。运行前初始化测试管理员和 22 名分页成员；完成后关闭 Web 服务。测试密码是公开的测试夹具，不能复制到真实环境。

五组验收位于 `tests/e2e/identity.spec.ts`：

1. 无 JavaScript 时，登录表单 POST 请求不将密码放入 URL。
2. 注册前端校验 → 待确认 → 管理员确认部门/角色 → 会话撤销 → 重新登录 → 普通员工管理页拒绝 → 审计详情 → 停用登录拒绝。
3. 管理员分页、取消授权无审计写入、网络失败与重试、退出后管理页保护。
4. 390×844 手机视口的注册错误、重复账号、普通员工资料和退出。
5. 手机管理员列表、授权表单及审计详情；页面无水平溢出，宽表格在容器内横向滚动。

自动截图在 `tmp/screenshots/s2c-*.png`；失败截图/trace 在 `tmp/playwright-results/`。均被 Git 忽略，迁移时通过测试重新生成；不得把带真实用户信息的截图或 trace 发布到公开仓库。本轮验收使用本机 Chrome，尚未覆盖 Safari、Firefox 或手机真机。

## 接续开发入口

- `src/server/page-auth.ts`：pageUser / requirePageUser，服务端页面会话与管理员检查；不要仅依赖 layout 隐藏导航。
- `src/server/organization.ts`：读取有效部门，页面不直接访问数据库。
- `src/components/auth-form.tsx`：明确写出的登录/注册字段，复用 `src/lib/identity.ts`。不是动态表单生成器。
- `src/components/account-shell.tsx`：导航、退出、会话刷新；`src/lib/api-client.ts`：同源 API 请求和错误处理。
- `src/components/users-panel.tsx` / `access-editor.tsx`：用户查询、授权预览与保存；`audit-panel.tsx`：只读审计。
- `src/components/use-resource.ts`：查询状态和重试；取消旧请求并匹配查询键，避免切页/筛选时旧结果覆盖当前页面。
- `src/app/globals.css`：共享表单、提示、布局、表格与移动断点。新页面沿用当前风格。

S3 从固定差旅业务开始，不在此阶段加入自定义模板、动态字段或可配置流程。相关人工边界见 HUMAN_HANDOFF.md。

框架参考：[Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies)、[服务端跳转](https://nextjs.org/docs/app/api-reference/functions/redirect)、[Playwright 测试服务](https://playwright.dev/docs/test-webserver)。
