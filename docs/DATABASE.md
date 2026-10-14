# S2 数据库与初始化

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

TEST_DATABASE_URL 必须指向名称以 `_test` 结尾的独立数据库。测试会清空该库的身份数据，不会使用 DATABASE_URL 对应的开发库。当前机器准备了 `approval_test`。

```sh
pnpm test
pnpm build
pnpm test:http
pnpm test:e2e
```

`test:http` 会执行测试库迁移、清空身份表并初始化临时测试管理员；生产构建在 127.0.0.1:3100 临时运行，按真实 HTTP 验证后自动关闭。`test:e2e` 也会重置测试身份数据、创建分页夹具，并在 3101 启动浏览器测试服务；首次需安装 Playwright Chromium，或用 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` 选择本机 Chrome。测试账号密码只用于临时测试库，不能用于交付；三组测试不能并行运行，详见 WEB_IDENTITY.md。

组织/身份外键：部门被用户引用时限制删除；角色被授权时限制删除；用户关联的会话与角色可级联清理，但有管理员审计引用的用户不能删除。系统提供停用而非物理删除用户。S2b 沿用 001_identity.sql，未修改旧迁移、未新增业务表。业务审批及人工自定义模块相关表尚未创建。
