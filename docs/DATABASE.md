# 数据库、迁移与初始化

数据库为 PostgreSQL 17。`db/migrations` 保存顺序迁移，`schema_migrations` 记录文件名、校验和和执行时间。迁移使用事务及数据库锁，失败回滚；已执行迁移不可原地修改，应新增迁移文件。

## Docker 方式

将 `.env.example` 复制为 `.env`，自行设置随机数据库密码和至少 12 字符的管理员初始密码。数据库连接中的密码必须与 POSTGRES_PASSWORD 一致；包含特殊 URI 字符时需要 URL 编码。

```sh
docker compose up -d db
pnpm db:migrate
pnpm db:seed
```

数据库端口仅绑定 127.0.0.1:55432，持久化到 postgres-data 卷。`docker compose down` 保留卷；不要使用 `down -v`，除非明确需要删除数据库。

当前开发机器没有 Docker，本阶段可用原生 PostgreSQL 实测；Compose 配置不能因此视为已经实机部署通过。完整 Web 镜像与跨机器重建验收留在后续交付阶段。

## 当前机器的原生 PostgreSQL

已安装 PostgreSQL 17，未启用 Homebrew 开机服务。项目数据目录为 `tmp/pgdata`，日志为 `tmp/postgres.log`，只监听本机 55432。`.env`、密码和数据目录均被 Git 忽略。

从工程根目录启动和停止：

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D tmp/pgdata -l tmp/postgres.log -o '-h 127.0.0.1 -p 55432 -k /tmp' start
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D tmp/pgdata stop -m fast
```

这些命令只适用于已初始化的本机目录。其他机器优先使用 Docker，或自行创建数据库后配置 DATABASE_URL。

## 初始数据与密码

初始化研发部、市场部、财务部及五类角色；首个管理员用户名 `admin`，密码来自本机 `.env` 的 ADMIN_INITIAL_PASSWORD。该账号是系统配置管理员，并不自动具有业务审批权。

重复初始化不会改写已有密码、不会重新提升已有账号权限，并且不会重复插入初始化审计。如果第一次初始化遇到保留用户名/邮箱被占用，则明确失败。初始化应在对外开放注册之前执行。

用户密码由 Node.js crypto 的 scrypt 处理，独立随机盐，N=32768/r=8/p=3，数据库不保存明文。S2b 已实现随机会话令牌签发，sessions.token_hash 仅保存 SHA-256 摘要，固定 8 小时过期；权限变更及退出会撤销会话，登录限流存于 auth_rate_limits。接口细节见 API.md。参考 [Node crypto](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) 与 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

## 独立测试库

TEST_DATABASE_URL 必须指向名称以 `_test` 结尾的独立数据库。测试会级联清空该库的身份和申请数据，不会使用 DATABASE_URL 对应的开发库。当前机器准备了 `approval_test`。

```sh
pnpm test
pnpm build
pnpm test:http
pnpm test:e2e
```

`test:http` 会执行测试库迁移、清空身份表并初始化临时测试管理员；生产构建在 127.0.0.1:3100 临时运行，按真实 HTTP 验证身份与草稿，并重启 Web 进程验证会话/草稿保留，完成后自动关闭。`test:e2e` 也会重置测试身份数据、创建分页夹具，并在 3101 启动浏览器测试服务；首次需安装 Playwright Chromium，或用 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` 选择本机 Chrome。测试账号密码只用于临时测试库，不能用于交付；三组测试不能并行运行，详见 WEB_IDENTITY.md。

组织/身份外键：部门被用户引用时限制删除；角色被授权时限制删除；用户关联的会话与角色可级联清理，但有管理员审计引用的用户不能删除。系统提供停用而非物理删除用户。S2b 沿用 001_identity.sql，未修改旧迁移、未新增业务表。提交审批及人工自定义模块相关表尚未创建。

## S3a 固定差旅草稿迁移

新增 `002_travel_drafts.sql`，通过 `pnpm db:migrate` 执行；不修改 001、不重置身份表、不需要重跑 seed。重复迁移保持现有记录。开发库和测试库各自执行迁移；测试数据不得复制进开发库。

- `applications`：UUID、唯一非空 app_no、标题、申请人/部门、类型/状态、version、创建/更新/提交时间；当前 type 仅允许 travel，默认 draft。状态枚举预留五种名称，但本轮没有状态流转 API。草稿 submitted_at 必须为 null，非草稿必须有提交时间。
- `application_number_seq`：首次保存草稿分配 `APP-` 加序号，数据库保证并发唯一；序列不循环，回滚和删除不回收。后续提交沿用该编号。它不是无空号的财务编号。
- `travel_requests`：通过 app_id 一对一关联主表；固定文本、开始/结束 DATE、NUMERIC(14,2) 预算与备注；duration_days 为数据库存储生成列，计算日期差加 1，缺日期时为 null。预算非负且有范围上界，日期有有效范围与先后约束。
- 申请人/部门外键均 RESTRICT；明细到主表也是 RESTRICT。只有经鉴权并锁定的本人未提交草稿，才能在同一事务显式先删明细再删主表，失败时完整回滚；不会通过删除用户或部门级联删除申请。
- `applications_applicant_drafts_idx` 支持本人草稿按更新时间和 ID 查询；列表与总数使用一个 SQL 快照。

草稿字段允许缺失，标题和文本用空串，未填日期/预算用 null，完整性在未来提交时另行验证。草稿 department_id 表示最近保存时的确认部门，未来提交必须再次核验并冻结部门归属。

当前没有 process_version_id、审批实例/任务/日志、重提关联或附件表；这些需要后续固定业务增量新增迁移。动态字段、模板发布与可配置规则仍由 S5 用户实现。不能把本轮主表理解为已交付整个设计模型。
