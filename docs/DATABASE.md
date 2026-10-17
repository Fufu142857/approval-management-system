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

`test:http` 会执行测试库迁移、清空身份表并级联清空业务数据，初始化临时测试管理员；生产构建在 127.0.0.1:3100 临时运行，按真实 HTTP 验证身份、草稿、固定提交及通过/驳回/撤回，并重启 Web 进程验证会话/草稿/已提交申请及快照、任务、日志、通知保留，完成后自动关闭。通知尚无 HTTP 查询接口，脚本仅在重启后查询测试库验证通知记录。`test:e2e` 也会重置测试身份数据、创建分页夹具，并在 3101 启动浏览器测试服务；首次需安装 Playwright Chromium，或用 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` 选择本机 Chrome。测试账号密码只用于临时测试库，不能用于交付；三组测试不能并行运行，详见 WEB_IDENTITY.md。

组织/身份外键：部门被用户引用时限制删除；角色被授权时限制删除；用户关联的会话与角色可级联清理，但有管理员审计或业务历史引用的用户不能删除。系统提供停用而非物理删除用户。001_identity.sql 保持不变，固定业务由 002–004 新迁移建立和扩展；人工自定义模块相关表尚未创建。

## S3a 固定差旅草稿迁移

新增 `002_travel_drafts.sql`，通过 `pnpm db:migrate` 执行；不修改 001、不重置身份表、不需要重跑 seed。重复迁移保持现有记录。开发库和测试库各自执行迁移；测试数据不得复制进开发库。

- `applications`：UUID、唯一非空 app_no、标题、申请人/部门、类型/状态、version、创建/更新/提交时间；当前 type 仅允许 travel，默认 draft。状态枚举预留五种名称，但本轮没有状态流转 API。草稿 submitted_at 必须为 null，非草稿必须有提交时间。
- `application_number_seq`：首次保存草稿分配 `APP-` 加序号，数据库保证并发唯一；序列不循环，回滚和删除不回收。后续提交沿用该编号。它不是无空号的财务编号。
- `travel_requests`：通过 app_id 一对一关联主表；固定文本、开始/结束 DATE、NUMERIC(14,2) 预算与备注；duration_days 为数据库存储生成列，计算日期差加 1，缺日期时为 null。预算非负且有范围上界，日期有有效范围与先后约束。
- 申请人/部门外键均 RESTRICT；明细到主表也是 RESTRICT。只有经鉴权并锁定的本人未提交草稿，才能在同一事务显式先删明细再删主表，失败时完整回滚；不会通过删除用户或部门级联删除申请。
- `applications_applicant_drafts_idx` 支持本人草稿按更新时间和 ID 查询；列表与总数使用一个 SQL 快照。

草稿字段允许缺失，标题和文本用空串，未填日期/预算用 null，完整性在未来提交时另行验证。草稿 department_id 表示最近保存时的确认部门，未来提交必须再次核验并冻结部门归属。

S3a 仅实现草稿；S3b 的实例/任务/日志见下节。当前仍没有 process_version_id、重提关联或附件表；不能把当前主表理解为已交付整个设计模型。

## S3b 固定差旅提交迁移

新增 `003_travel_submission.sql`，按原命令迁移，不修改 001/002，不重置开发库账号。提交事务将 applications 置 pending 并冻结当前部门，version 加 1；travel_requests 的固定明细沿用保存内容。

- `approval_instances`：每份申请最多一个实例，保存 rule_version、submitted_version、route_snapshot JSONB 与创建时间。固定 v1 的 JSON 保存规则说明、申请人/部门、两级实际人员及名称、预算与天数；实例行禁止 UPDATE/DELETE。
- `approval_tasks`：每实例 seq_no 唯一，固定两步为 pending/blocked；部分唯一索引保证每实例最多一个 pending。保存实际 approver_id 与节点名，当前不提供转派。状态枚举预留未来动作，但 S3b 只创建待办。
- `approval_logs`：保存实例、可空任务、操作者、动作/意见/结果、申请版本和时间。提交日志每实例唯一；复合外键保证有任务时属于同一实例。触发器禁止 UPDATE/DELETE，日志只追加。
- `notifications`：接收人、申请、事件键、类别、标题、创建/阅读时间。recipient_id/event_key 唯一，首节点事件为 `task:<任务UUID>:pending`；S3b 写入新待办通知，S3c 补充终态事件；read_at 为 null，尚无已读或查询接口。

所有业务外键限制删除，不以用户或申请删除级联擦除历史。测试库的 TRUNCATE CASCADE 只用于隔离夹具，不能用于开发或交付数据。触发器约束面向正常应用写入，不表示数据库所有者无法通过 DDL 绕过。

固定规则直接由差旅服务确定，不读取管理员可配置模板。与设计逻辑模型的映射是：暂用不可变 `rule_version + route_snapshot` 保存固定流程版本及步骤信息，没有创建 process_templates/process_versions/process_steps 或 application_field_values。动态版本发布、字段和可配置规则解释仍由 S5 用户独立实现，不能宣称当前已完成这些设计实体。

提交沿用锁顺序：组织 advisory 72002 共享锁 → 会话/有效部门共享行锁 → 申请行排他锁 → 版本及完整性检查 → 实例/任务/日志/通知一次提交。所有组织授权写入必须持有同号排他锁；人员变化不会篡改既有快照。S3c 审批/撤回沿用同一申请锁；详情的一致性机制见下节。

## S3c 顺序审批与撤回迁移

新增 `004_travel_actions.sql`，不改已执行的 001–003。approval_tasks 增加 activated_at/finished_at；旧 S3b pending 任务用原 created_at 回填激活时间，blocked 保持 null。CHECK 约束要求 blocked 两时间均空、pending 已激活未完成、approved/rejected 已激活且已完成、cancelled 有完成时间。撤回时未激活的未来任务也会 cancelled，但 activated_at 仍为空，以此区分正文访问权限。

审批日志新增 `(instance_id, application_version)` 唯一索引，以及仅 approved/rejected 动作的 task_id 唯一索引；同一任务最多一条批准或驳回日志。撤回关联当时 pending 任务，不伪造审批动作。现有不可变触发器、单 pending 索引和通知接收人/事件键唯一约束继续有效。

状态写事务先锁申请，再读快照任务和校验版本/归属；先关闭当前任务再激活下一步，避免同实例双 pending。详情先获取申请共享锁，待写事务提交后在新语句中查询权限及正文，再读任务/日志，保持一致。后续所有业务状态写入必须沿用申请锁；不能单独更新任务、日志或通知绕过事务。

原实例、编号、提交时间和人员快照不会随审批修改；后续人员禁用阻止激活但不重新解析角色。终态通知接收人、键值和失效待办通知的处理见 API.md。已激活人员可读历史；未激活取消人员不能读正文。没有模板配置、通用规则解释、复制重提或附件表，后续仍分阶段实现。
