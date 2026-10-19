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

`test:http` 会执行测试库迁移、清空身份表并级联清空业务数据，初始化临时测试管理员；生产构建在 127.0.0.1:3100 临时运行，按真实 HTTP 验证身份、草稿、固定提交及通过/驳回/撤回，并重启 Web 进程验证会话/草稿/已提交申请及快照、任务、日志、通知保留，完成后自动关闭。S3d 另通过真实 HTTP 验证通知列表/详情/筛选/未读数/幂等已读及权限，重启后核对首次阅读时间；原有事件去重也通过独立测试库查询检查。`test:e2e` 也会重置测试身份数据、创建分页夹具，并在 3101 启动浏览器测试服务；首次需安装 Playwright Chromium，或用 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e` 选择本机 Chrome。测试账号密码只用于临时测试库，不能用于交付；三组测试不能并行运行，详见 WEB_IDENTITY.md。

组织/身份外键：部门被用户引用时限制删除；角色被授权时限制删除；用户关联的会话与角色可级联清理，但有管理员审计或业务历史引用的用户不能删除。系统提供停用而非物理删除用户。001_identity.sql 保持不变，固定业务由 002–007 新迁移建立和扩展；人工自定义模块相关表尚未创建。

## S3a 固定差旅草稿迁移

新增 `002_travel_drafts.sql`，通过 `pnpm db:migrate` 执行；不修改 001、不重置身份表、不需要重跑 seed。重复迁移保持现有记录。开发库和测试库各自执行迁移；测试数据不得复制进开发库。

- `applications`：UUID、唯一非空 app_no、标题、申请人/部门、类型/状态、version、创建/更新/提交时间；当前 type 仅允许 travel，默认 draft。状态枚举预留五种名称，但本轮没有状态流转 API。草稿 submitted_at 必须为 null，非草稿必须有提交时间。
- `application_number_seq`：首次保存草稿分配 `APP-` 加序号，数据库保证并发唯一；序列不循环，回滚和删除不回收。后续提交沿用该编号。它不是无空号的财务编号。
- `travel_requests`：通过 app_id 一对一关联主表；固定文本、开始/结束 DATE、NUMERIC(14,2) 预算与备注；duration_days 为数据库存储生成列，计算日期差加 1，缺日期时为 null。预算非负且有范围上界，日期有有效范围与先后约束。
- 申请人/部门外键均 RESTRICT；明细到主表也是 RESTRICT。只有经鉴权并锁定的本人未提交草稿，才能在同一事务显式先删明细再删主表，失败时完整回滚；不会通过删除用户或部门级联删除申请。
- `applications_applicant_drafts_idx` 支持本人草稿按更新时间和 ID 查询；列表与总数使用一个 SQL 快照。

草稿字段允许缺失，标题和文本用空串，未填日期/预算用 null，完整性在未来提交时另行验证。草稿 department_id 表示最近保存时的确认部门，未来提交必须再次核验并冻结部门归属。

S3a 仅实现草稿；S3b 的实例/任务/日志见下节。当前仍没有 process_version_id 或重提关联；附件表见 S3e；不能把当前主表理解为已交付整个设计模型。

## S3b 固定差旅提交迁移

新增 `003_travel_submission.sql`，按原命令迁移，不修改 001/002，不重置开发库账号。提交事务将 applications 置 pending 并冻结当前部门，version 加 1；travel_requests 的固定明细沿用保存内容。

- `approval_instances`：每份申请最多一个实例，保存 rule_version、submitted_version、route_snapshot JSONB 与创建时间。固定 v1 的 JSON 保存规则说明、申请人/部门、两级实际人员及名称、预算与天数；实例行禁止 UPDATE/DELETE。
- `approval_tasks`：每实例 seq_no 唯一，固定两步为 pending/blocked；部分唯一索引保证每实例最多一个 pending。保存实际 approver_id 与节点名，当前不提供转派。状态枚举预留未来动作，但 S3b 只创建待办。
- `approval_logs`：保存实例、可空任务、操作者、动作/意见/结果、申请版本和时间。提交日志每实例唯一；复合外键保证有任务时属于同一实例。触发器禁止 UPDATE/DELETE，日志只追加。
- `notifications`：接收人、申请、事件键、类别、标题、创建/阅读时间。recipient_id/event_key 唯一，首节点事件为 `task:<任务UUID>:pending`；S3b 写入新待办通知，S3c 补充终态事件；read_at 为 null，S3d 提供已读与查询接口。

所有业务外键限制删除，不以用户或申请删除级联擦除历史。测试库的 TRUNCATE CASCADE 只用于隔离夹具，不能用于开发或交付数据。触发器约束面向正常应用写入，不表示数据库所有者无法通过 DDL 绕过。

固定规则直接由差旅服务确定，不读取管理员可配置模板。与设计逻辑模型的映射是：暂用不可变 `rule_version + route_snapshot` 保存固定流程版本及步骤信息，没有创建 process_templates/process_versions/process_steps 或 application_field_values。动态版本发布、字段和可配置规则解释仍由 S5 用户独立实现，不能宣称当前已完成这些设计实体。

提交沿用锁顺序：组织 advisory 72002 共享锁 → 会话/有效部门共享行锁 → 申请行排他锁 → 版本及完整性检查 → 实例/任务/日志/通知一次提交。所有组织授权写入必须持有同号排他锁；人员变化不会篡改既有快照。S3c 审批/撤回沿用同一申请锁；详情的一致性机制见下节。

## S3c 顺序审批与撤回迁移

新增 `004_travel_actions.sql`，不改已执行的 001–003。approval_tasks 增加 activated_at/finished_at；旧 S3b pending 任务用原 created_at 回填激活时间，blocked 保持 null。CHECK 约束要求 blocked 两时间均空、pending 已激活未完成、approved/rejected 已激活且已完成、cancelled 有完成时间。撤回时未激活的未来任务也会 cancelled，但 activated_at 仍为空，以此区分正文访问权限。

审批日志新增 `(instance_id, application_version)` 唯一索引，以及仅 approved/rejected 动作的 task_id 唯一索引；同一任务最多一条批准或驳回日志。撤回关联当时 pending 任务，不伪造审批动作。现有不可变触发器、单 pending 索引和通知接收人/事件键唯一约束继续有效。

状态写事务先锁申请，再读快照任务和校验版本/归属；先关闭当前任务再激活下一步，避免同实例双 pending。详情先获取申请共享锁，待写事务提交后在新语句中查询权限及正文，再读任务/日志，保持一致。后续所有业务状态写入必须沿用申请锁；不能单独更新任务、日志或通知绕过事务。

原实例、编号、提交时间和人员快照不会随审批修改；后续人员禁用阻止激活但不重新解析角色。终态通知接收人、键值和失效待办通知的处理见 API.md。已激活人员可读历史；未激活取消人员不能读正文。没有模板配置、通用规则解释或复制重提，后续仍分阶段实现；附件见 S3e。

## S3d 本人通知读取与已读

新增 `005_notification_unread_index.sql`：在 notifications(recipient_id, created_at DESC, id DESC) 建立 read_at IS NULL 的部分索引，支持本人未读计数/筛选；不修改旧迁移或事件记录。原接收人/事件键唯一约束保持不变，未新增通知种类或创建途径。

查询事务先调用 requireBusinessActor，沿用组织共享锁与会话/有效部门检查。列表在一个 SQL 快照中获取本人分页条目、筛选后 total、全量 unreadCount 和关联状态；通知详情也在单条查询中读取事件与当前申请/任务状态。与申请正文多查询不同，此处不锁申请行；单语句保证不会拼接一次状态事务的部分结果，但返回之后状态仍可能变化，打开正文需重新鉴权读取。

标记已读只按通知 ID 加会话用户 recipient_id 条件执行 UPDATE，使用 COALESCE(read_at, clock_timestamp())；数据库行锁保证并发请求保留第一次成功的时间。事务失败不改变未读状态，不写审批日志或新通知。用户不能提交接收人或阅读时间；无批量已读/删除/恢复未读接口。

查询中的正文权限使用申请人或已激活任务人员规则，与 S3c 一致。若将来增加转派/权限规则，须同步复核通知 target 与正文授权；当前 target 是固定差旅的鉴权 API 路径，不是通用流程解释或尚未实现的 UI 链接。

## S3e 私有附件与文件一致性

新增 `006_travel_attachments.sql`，旧迁移不改。attachments 通过 app_id/uploader_id 外键 RESTRICT 关联申请和上传用户，记录唯一 UUID storage_key、原名、MIME、实际大小、SHA-256 与创建时间；按申请/时间/ID 建索引。数据库限制 MIME 枚举、单件正数/10 MiB 和摘要格式，申请件数/累计容量及草稿权限由持有申请锁的服务强制验证，不表示数据库所有者无法绕过服务直接修改数据。API 不接受客户端提供这些元数据。

文件默认在工程根 `uploads/attachments`，可通过 ATTACHMENT_STORAGE_DIR 指定绝对或相对工程根的私有目录；禁止 public 内路径，包括解析后的符号链接路径。根目录按 0700 创建，随机 UUID.blob 文件按 0600 排他创建，原名不参与文件路径，文件读写拒绝符号链接。文件写入后同步文件与目录再提交数据库元数据；下载/提交读取时核对字节数及摘要。当前在 macOS 本机原生运行验证；Docker/Linux 文件系统语义与 volume 随部署阶段再验收。

上传、删除附件、删除草稿：组织 72002 共享锁 → 会话/有效部门检查 → 存储 72004 共享锁 → 申请排他行锁 → 核版本/数量/容量 → 写入。成功上传或单件删除使申请版本加 1；删除整份草稿先删附件索引、业务明细和主表。读取附件先业务鉴权，再申请共享行锁，按最新状态判断所有权/已激活任务权限；锁保持至文件读取完成。提交持有申请排他锁，因此附件增删不能穿插提交冻结。

数据库与文件系统不能组成同一原子事务，采用以下补偿：

1. 上传先持久化随机文件，再提交元数据。失败后尝试回收；提交结果不确定时**不直接 unlink**，等待数据库释放锁并检查最终引用。进程崩溃可能留下未引用文件。
2. 删除先提交元数据删除，成功后回收物理文件。数据库失败不动原文件；回收失败只记录通用日志，删除结果仍成功，可稍后重试。已提交申请不提供删除入口。
3. `pnpm attachments:gc` 读取 .env 当前 DATABASE_URL 与 ATTACHMENT_STORAGE_DIR，持有 72004 排他事务锁，等待正在上传/删除的事务完成，再查询持久化引用。只删私有目录内未引用的 UUID.blob 普通文件，保留有引用对象、其他名称及符号链接。回收只拿存储锁，不反向获取组织/申请锁。返回 removed/retained 数量；retained 是数据库引用数量，不是文件健康检查。没有后台定时任务。

CLI 适用于异常恢复及部署维护；不要拿开发库连接配测试文件目录或反过来，也不要让不同数据库共享附件目录。自动测试分别固定到 `tmp/attachments-vitest-test`、`tmp/attachments-http-test`、`tmp/attachments-e2e-test`，不会回收开发 uploads。测试套件仍不可并行，因为共用隔离 TEST_DATABASE_URL。

环境迁移/备份时暂停业务写入与回收，成对保存数据库和整个附件目录，再同时恢复；不能只复制 Git 仓库或只备份数据库。运行目录被忽略，不上传票据原件。若已提交文件缺失或损坏，恢复匹配 SHA-256 的原对象；下载返回 409，不能通过重新上传改写历史。新环境先 `pnpm db:migrate` 到 007，再启动服务；无需重置或 seed 现有库。

验证：16 项附件测试使用真实 PG 和私有文件目录，覆盖格式、权限、冻结、版本竞争、故障补偿、完整性检查与回收等待上传。HTTP 测试使用独立存储，真实生产路由完成上传/删除/预览下载，并重启 Web 后核对元数据与文件字节。它不等于重启数据库、断电故障注入、病毒扫描或 Docker 部署验收。

## S3f Web 验收补充

没有新增迁移，开发库维持 006，未重置现有数据。浏览器测试夹具仅在 approval_test 为 roster_20/21 分配部门负责人/财务角色，供真实差旅提交使用；原有管理员授权测试仍单独验证。PDF.js 公开资源在 dev/build 时生成于 public/vendor/pdfjs，用户附件仍在 ATTACHMENT_STORAGE_DIR；这两者不可互换。生产部署复制完整 public 资源时，只含公开库文件，不应加入任何附件原件。

## S3g 固定差旅列表索引与快照

007_travel_list_indexes.sql 新增 applications(applicant_id, created_at DESC, id) 的 travel 部分索引；将旧 pending 任务的 created_at 索引替换为按 activated_at 排序的索引，并新增 approved/rejected 任务按 approver_id、finished_at DESC、id 的部分索引。只调整访问路径，不改申请/任务/快照数据或 001–006 迁移，不需要 seed 或重置数据库。开发库应用结果见 STATUS/开发日志。

申请和任务列表先在事务中取得组织共享锁并检查有效会话/部门，再以单条 SQL 同时查询匹配结果、总数、当前节点、冻结姓名和申请版本。与多查询详情不同，列表不锁申请行；单语句快照避免读取审批事务的部分修改，返回后状态仍会变化，后续审批必须重新鉴权和检查 taskId/version。列表不会改通知、日志或任务时间。

时间筛选按上海日历日；申请列表用创建时间、待办用激活时间、已办用完成时间。已办按决策任务而非申请去重，取消任务不算完成审批。筛选/返回契约见 API.md；没有跨类型模板查询或人工模块专用表。

## S3h Web 接入

无新增迁移，开发库仍为 007。新增浏览器审批场景只使用独立 approval_test 中已有固定角色夹具，沿用原隔离附件目录；不会更改开发库账号或申请。所有写入仍调用 S3c 事务服务，S3g 列表查询/索引不变。

S3i 只接入已有通知 API 的 Web 页面与可见轮询，无新增迁移，开发库仍为 007，未重置开发账号或申请。浏览器/业务/HTTP 测试继续串行使用独立 approval_test 与隔离附件目录。
