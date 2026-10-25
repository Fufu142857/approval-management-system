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

组织/身份外键：部门被用户引用时限制删除；角色被授权时限制删除；用户关联的会话与角色可级联清理，但有管理员审计或业务历史引用的用户不能删除。系统提供停用而非物理删除用户。001_identity.sql 保持不变，固定业务由 002–010 新迁移建立和扩展；人工自定义模块相关表尚未创建。

## S3a 固定差旅草稿迁移

新增 `002_travel_drafts.sql`，通过 `pnpm db:migrate` 执行；不修改 001、不重置身份表、不需要重跑 seed。重复迁移保持现有记录。开发库和测试库各自执行迁移；测试数据不得复制进开发库。

- `applications`：UUID、唯一非空 app_no、标题、申请人/部门、类型/状态、version、创建/更新/提交时间；S3a 时 type 仅允许 travel，009 已扩展到 travel/purchase；状态默认 draft。S3 已有差旅流转，S4c 已有采购草稿提交和固定执行实例，S4d 已有采购审批/撤回。草稿 submitted_at 必须为 null，非草稿必须有提交时间。
- `application_number_seq`：首次保存草稿分配 `APP-` 加序号，数据库保证并发唯一；序列不循环，回滚和删除不回收。后续提交沿用该编号。它不是无空号的财务编号。
- `travel_requests`：通过 app_id 一对一关联主表；固定文本、开始/结束 DATE、NUMERIC(14,2) 预算与备注；duration_days 为数据库存储生成列，计算日期差加 1，缺日期时为 null。预算非负且有范围上界，日期有有效范围与先后约束。
- 申请人/部门外键均 RESTRICT；明细到主表也是 RESTRICT。只有经鉴权并锁定的本人未提交草稿，才能在同一事务显式先删明细再删主表，失败时完整回滚；不会通过删除用户或部门级联删除申请。
- `applications_applicant_drafts_idx` 支持本人草稿按更新时间和 ID 查询；列表与总数使用一个 SQL 快照。

草稿字段允许缺失，标题和文本用空串，未填日期/预算用 null，完整性在未来提交时另行验证。草稿 department_id 表示最近保存时的确认部门，未来提交必须再次核验并冻结部门归属。

S3a 仅实现草稿；S3b 的实例/任务/日志见下节。当前仍没有 process_version_id；重提关联由 S3j 的 008 增加；附件表见 S3e；不能把当前主表理解为已交付整个设计模型。

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

原实例、编号、提交时间和人员快照不会随审批修改；后续人员禁用阻止激活但不重新解析角色。终态通知接收人、键值和失效待办通知的处理见 API.md。已激活人员可读历史；未激活取消人员不能读正文。没有模板配置或通用规则解释；复制重提见 S3j，其他业务仍分阶段实现；附件见 S3e。

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

环境迁移/备份时暂停业务写入与回收，成对保存数据库和整个附件目录，再同时恢复；不能只复制 Git 仓库或只备份数据库。运行目录被忽略，不上传票据原件。若已提交文件缺失或损坏，恢复匹配 SHA-256 的原对象；下载返回 409，不能通过重新上传改写历史。新环境先 `pnpm db:migrate` 到 015，再启动服务；无需重置或 seed 现有库。

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

## S3j 固定差旅重提关联

008_travel_resubmission.sql 新增 applications.resubmission_of 可空 UUID、自外键 ON DELETE RESTRICT、UNIQUE 与非自身检查。触发器要求新关联记录为同一申请人的 travel 草稿，来源为 rejected/withdrawn；来源永不可改写，已关联记录也不能更改类型/申请人。既有记录来源为 null，001–007 不改动。

事务先组织/身份/部门锁，再锁原申请（POST FOR UPDATE，GET FOR SHARE），核原版本后查已有后续；已有则返回当前摘要，无则插入主表与固定差旅明细。新 ID/编号/version=1、当前部门，无附件或执行记录。原申请的 version/updated_at/提交时间/日志/通知/附件均不写入；没有文件复制。唯一约束限制一个存活的直接后续，删除未提交后续释放位置；后续提交后按既有不可变历史约束保留，再次驳回/撤回可从后续延长链。更新触发器不反查原申请，避免与复制锁序形成反向锁等待。

本机开发库已应用 008 并重复迁移；应用前后对身份、部门/角色、申请（排除新增可空列）、差旅明细、审批实例/任务/日志、通知和附件元数据的排序 JSON 摘要核对一致。未重置或 seed 开发库；附件文件不参与此迁移。测试继续串行使用独立 approval_test 和隔离附件目录。

## S4a 固定采购草稿

009_purchase_drafts.sql 将 applications.type 检查扩展为 travel/purchase（默认 travel 不变），新增 purchase_requests（app_id 一对一）、purchase_items 与 supplier_quotes（一对多）。仅固定字段，未增加流程模板、动态表单或采购执行实例。原 001–008 不变，存量差旅数据无需改写。

purchase_requests 存原因、期望日期、项目、预算上限、选择理由、single_source 明示标记及说明、备注。items 存 UUID、申请、position、名称、规格、quantity NUMERIC(12,3)、单位、unit_price NUMERIC(14,2)；amount NUMERIC(14,2) 为 round(quantity * unit_price,2) 生成列。quotes 存 UUID、申请、position、供应商、报价日、正金额、依据、购买链接、is_online、selected。报价附件外键已由 S4b 的 010 添加，见下文。

所有外键 RESTRICT，不因删除身份/申请自动丢失历史。写服务先组织/身份/部门锁，再申请行锁；三张采购表触发器也锁申请并要求 purchase/draft，阻止更换 app_id/行 ID 和非草稿修改/删除。采购主表类型不能切换为差旅，差旅也不能切换为采购。明细/报价的 (app_id,position) 唯一约束延迟到提交检查，允许同一事务稳定 ID 重排；报价按 app_id 的 selected 部分唯一索引限制最多选一家，替换前先撤销原选择再设置新选择。数量和单价为正或 null，预算非负或 null；日期限制 0001–9999 年。positions 为 1–100 / 1–20。

采购总额从明细按 NUMERIC 求和，不另存冗余值；任一行金额未填写或零行返回 null。应用层通过 BigInt 校验每行舍入和累计上限。草稿保存校验值的合法性，不要求完整比价、预算覆盖、选择说明、单一来源说明或线上附件；这些条件不等于已通过提交验收。接口边界见 API.md。

GET 详情先锁主表 FOR SHARE，再读取头部/明细/报价；PUT/DELETE 持有 FOR UPDATE，所有修改及版本一起提交。列表摘要/计数/金额单 SQL 快照。S4a 时删除草稿按报价 → 明细 → 采购主表 → 申请；S4b 已扩展为先取存储锁、删除附件元数据，再删报价/明细/主表/申请，提交后回收文件。

开发库已应用 009 并重复迁移；前后对 users、departments、user_roles、sessions、admin_audit_logs、applications、travel_requests、approval_instances/tasks/logs、notifications 与 attachments 的排序 JSON 摘要核对一致，未重置或 seed 原库。新增采购表初始为空，既有文件未改动。测试继续使用独立 approval_test。

## S4b 采购报价附件

010_purchase_quote_attachments.sql 为 attachments 新增可空 supplier_quote_id，并以 (supplier_quote_id, app_id) 复合外键引用 supplier_quotes(id, app_id)，ON DELETE RESTRICT；按报价建索引。已有差旅行新列为 null，原行和文件不用改写。触发器持申请行锁，要求采购附件插入时申请为 purchase/draft、报价非空且上传人为申请人；报价实际属于同一申请由复合 FK 保证，非采购不得携带报价外键。采购附件元数据不可 UPDATE，非草稿不能 INSERT/DELETE；不得通过重新绑定把已有文件挪到另一报价。

采购附件服务只允许本人有效草稿，读取列表与内容持申请共享锁，上传/删除先组织/身份/部门 → 存储共享锁 72004 → 申请排他锁，再核最新 version、报价/附件归属和整单配额。使用现有私有文件存储、格式解析及摘要校验；没有新增文件路径或第二套回收器。所有报价共用 9 件、50 MiB 限额，单件 10 MiB。

purchase.ts 的报价替换先检查被省略报价是否有附件：有则 409 QUOTE_HAS_ATTACHMENTS 并完整回滚，不能用 PUT 隐式丢弃文件。保留相同 quoteId 的编辑/排序不会修改附件。整单 DELETE 新增存储锁和元数据删除，成功提交后才回收文件，数据库错误不先删物理文件。单文件删除也先提交元数据/版本再回收；上传失败通过持久引用检查回收孤儿。提交结果不确定时保留可能仍被引用的对象，不用异常直接推断文件应该删除。

回收继续扫描整张 attachments 表，差旅/采购的有效对象都保留。数据库、附件目录需成对备份/迁移；无法立即回收时保留孤儿并记录清理提示，恢复存储后运行 pnpm attachments:gc。S4b 接口仍仅做草稿附件；S4c 已另行实现提交后正文/文件访问，按真实采购权限读取及核文件完整性。

开发库已应用 010 并重复迁移；对身份/会话/审计、采购/差旅、执行/通知和附件既有字段的排序 JSON 摘要核对一致（附件排除新增 supplier_quote_id 列），未重置/seed 或修改既有文件。原差旅附件新列为 null；测试仍使用独立 approval_test 与隔离存储。

## S4c 固定采购提交

无新增迁移，开发库仍为 010，未重置/seed 或改写开发业务数据。采购复用已有 approval_instances/tasks/logs/notifications 表；不是动态流程或模板表。提交持组织/身份/部门锁 → 申请 FOR UPDATE，校验已存明细、报价和原附件后，单事务改状态/版本/提交时间、创建 fixed-purchase-v1 实例、两任务、日志与通知。用户确认第二步为企业负责人（company_head），第一步 department_head；当前组织解析后冻结，后续角色变更不改旧快照。

采购详情与文件读取持申请 FOR SHARE，并在锁后新语句中校验本人或 activated_at 非空的实际任务人员。上传/删除仍为组织 → 存储 → 申请，不新增反向锁顺序；提交只读取已经持久引用的文件，不取存储锁。009 的采购三表触发器和 010 的附件触发器负责非草稿冻结；已有实例/日志不可改删。新快照内容、报价未知金额比较与预算口径详见 API.md。S4d 已接入独立采购动作服务，不得直接调用差旅动作推进采购。

## S4d 采购审批动作

无新迁移，仍为 010，开发库和私有附件未重置或写入测试数据。purchase-actions.ts 以组织/身份/部门 → purchase 申请 FOR UPDATE 的锁序推进已冻结任务；先关闭当前 pending，再激活下一 blocked，使用已有单 pending、日志版本/任务唯一和通知去重约束。审批/撤回不改采购三表、附件、实例快照或 submitted_at；申请仅状态/version/updated_at 改变，日志追加。

任何任务/申请/日志/通知写入失败都整体回滚。下一人员的有效性检查发生在持组织共享锁期间，管理写入采用同号排他锁；保持原人员，不按新角色重新解析。撤回取消未办任务并向本人及已激活任务人员去重通知。读取仍持申请共享锁，等写事务提交后按实际激活记录重新授权；取消但从未激活的企业节点不能读正文/附件。采购与差旅动作分别按固定 type 过滤，不涉及人工模块的动态规则解释。

## S4e 采购列表索引与读取

011_purchase_list_index.sql 新增 applications_purchase_applicant_created_idx：applications(applicant_id, created_at DESC, id) WHERE type='purchase'。不修改原 001–010、表结构、记录或人员快照。007 的任务索引没有业务类型条件，采购继续复用 pending 的 activated_at 与 handled 的 finished_at 索引，无需重复建同类索引。

采购本人/任务列表以单条 SQL 的一致快照同时返回总数、分页、申请/任务状态、版本、当前节点及 purchase_items.amount 精确合计，不从客户端或浮点推算金额。列表不取申请行锁，允许返回已提交的旧或新完整状态，不暴露进行中的部分写入；后续动作仍独立核版本与权限。时间按上海日历日，业务范围/排序/已办定义详见 API.md。

开发库已应用并重复执行 011；对身份/会话/角色/审计、申请、采购/差旅明细、报价、审批/通知及附件共 17 张表的排序 JSON 摘要核对完全一致，采购索引存在。未重置或 seed 开发库，既有私有附件未修改；测试使用独立 approval_test 与隔离存储，不声称大数据量性能压测。

## S4i 固定采购重提关联

012_purchase_resubmission.sql 用 CREATE OR REPLACE 扩展既有 preserve_travel_resubmission() 触发函数，保留原函数/触发器名称与既有 008 唯一、自引用和 FK 约束。仅允许同类型 travel/purchase、同申请人、来源 rejected/withdrawn 的新 draft；来源不可改写、已关联记录不得更改申请人/类型。001–011 迁移不改动，无新增表或人工模块结构。

事务顺序为组织/身份/部门 → 原申请（POST 排他、GET 共享）→ 已有后续共享；无后续则插入主表、采购固定字段、明细和报价。新行 ID 由数据库生成，数量/单价/金额用 NUMERIC 原值复制，不经过浮点，amount 重新精确生成。任何一步失败整单回滚。原正文/时间/版本/任务/日志/通知均不修改；附件不复制，不需文件系统操作。现有后续更新不反查来源，保持锁序。

开发库已应用并重复执行 012；迁移前后核对身份、部门/角色、会话、审计、限流、申请、差旅/采购明细、实例/任务/日志、通知及附件共 17 表排序 JSON 摘要一致。未重置或 seed 开发库，私有附件不变。迁移及业务测试使用独立 approval_test，Web/HTTP 重启测试不等同数据库进程或 Docker 重启。

## S4j 固定报销草稿与跨单关联

013_reimbursement_drafts.sql 将 applications.type 扩展为 travel/purchase/reimbursement；新增 reimbursement_requests（说明/独立报销理由/备注）、reimbursement_items（顺序/五类费用/日期/用途/正金额/无票标记及理由）、application_links（已批采购或差旅source → 报销target）。001–012 不改，resubmission_of 的差旅/采购规则不扩展到报销；新关联与复制重提完全不同。

费用金额 NUMERIC(14,2)，最多100行，(app_id,position) 延迟唯一约束支持重排，UUID/app_id 不可改绑。合计在读取时由 SQL SUM 计算，不冗余写回头部、不信任客户端；缺金额或零行返回null。草稿允许未完整填写，提交阶段再校验必填、独立/无票理由及票据。本阶段不加附件外键、票据/OCR结构或动态模板结构。

链接复合主键禁止重复，source FK 到 applications、target FK 到 reimbursement_requests，全部 RESTRICT；目标索引支持反向查询/删除。触发器要求目标是 reimbursement/draft，来源是同申请人、approved、travel/purchase；禁止 UPDATE 改绑链接，替换用显式删旧/插新。报销主表禁止改变类型/申请人，正文/费用/链接在非草稿时禁止写。数据库 FK/触发器是结构保护，不替代 API 身份与权限检查。

服务锁序：组织72002共享 → 会话/有效部门 → 报销申请（写排他，读共享）→ 来源按UUID排序共享。创建的新目标本身由当前事务持有；所有多表更新在同一事务，任何失败回滚。候选列表/草稿列表单SQL计数和分页，详情跨查询持目标锁并重新核来源；取消链接/删除报销不修改源正文/历史或附件。关联读取失败可以通过完整 PUT 清空无效关联恢复。

开发库迁移及存量摘要核验结果见 STATUS.md / DEVELOPMENT_LOG.md。测试仅在 approval_test 及隔离目录，不能运行 reset/seed 开发库。S4k 将补票据附件元数据及含票据行/整单删除补偿，当前删除仅删除链接、费用行、报销头与草稿申请。

## S4k 报销票据关联

014_reimbursement_attachments.sql 给 attachments 增加 reimbursement_item_id UUID（默认NULL）和 receipt_number VARCHAR(100) NOT NULL DEFAULT ''。复合 FK(reimbursement_item_id,app_id) 指向 reimbursement_items(id,app_id)，删除RESTRICT；增加明细非空索引及号码非控制字符/边缘空格约束。每份记录只有一个费用外键，无复用关联表；票据号码不唯一，未实施按号码/文件摘要去重。

新增触发器保护报销附件：只有报销draft且上传人为申请人、费用非空、报价外键为空才可插入；元数据/号码/归属不可UPDATE，非草稿不可删除。其他类型禁止带报销明细或非空号码。现有010采购触发器保留，001–013不修改，旧差旅/采购的两个新列分别为NULL/空串。

报销上传、单件删除、整单删除遵守组织→存储72004共享锁→申请FOR UPDATE；PUT仅持申请锁，不删除文件，省略有票据费用返回ITEM_HAS_ATTACHMENTS。整单先删attachments，再删链接/费用/报销头/申请；事务失败保留引用和原文件。成功后共用GC按持久引用回收，上传异常/提交不确定也不能盲删。列表/内容持申请共享锁，读取原文件校验大小/摘要。

开发库014已应用并重复验证，20张既有表迁移前后原字段摘要一致，attachments比较原有字段（排除新增默认列），新增明细/号码均为NULL/空串；没有重置/seed开发库或移动私有文件。新环境迁移应包含001–015（S4n增加列表索引），数据库与附件目录需配对备份。

## S4l 报销提交与冻结证据

无新迁移，仍为014；现有approval_instances/tasks/logs/notifications支持固定报销，013/014的草稿明细、关联与票据保护继续生效。提交持组织共享锁、本人申请FOR UPDATE，再按UUID排序持关联源FOR SHARE；字段/费用/票据和来源均在该事务重验，随后原子写申请状态/version/部门/提交时间、fixed-reimbursement-v1实例、两任务/首激活、日志及通知。失败回滚所有数据库写入，提交只读私有文件，不移动或回收对象。

route_snapshot新增固定报销内容：必要linkedApplications摘要、独立说明、精确总额、noReceiptItems例外及attachmentEvidence（记录/明细/号码/类型/大小/摘要）。原存储键不进入快照。关联源正文/历史/版本不改，后续详情使用冻结摘要，不能据报销权限读取实时源正文或附件。实例/日志不可变；读取持申请共享锁，锁后按本人/已激活任务重新授权。组织调整不重算人员，动作推进已由S4m实现。

开发库无需新增迁移或seed；本阶段验证仅使用approval_test及隔离文件目录，不修改开发业务数据/私有票据。测试中的原始SQL异常源/任务变更仅用于验证权限边界，不是提供给业务的动作接口。

## S4m 报销审批动作

无新迁移，沿用003/004的执行表、任务时间约束、单pending唯一索引、日志版本/决策唯一约束，以及013/014的报销与票据冻结保护。动作取得组织共享锁、认证/有效部门锁后，对type=reimbursement申请FOR UPDATE；只能按被冻结的实际任务人员和最新version流转，不解析新任角色。先关闭当前任务再激活后续，或取消未办；主表状态/version/updated_at、任务activated_at/finished_at、日志和通知同事务更新。任务、主表、日志或通知失败全部回滚。

不修改费用、金额、无票声明、application_links、原来源、提交时间、实例快照和票据；不移动或删除私有文件。返回详情沿用S4l已授权冻结来源摘要，避免审批角色获得源单权限。读详情/票据取得同一申请共享锁后重验实际激活记录；批准尚未提交时，未来财务的读取须等待事务完成。测试仅操作approval_test及隔离文件目录，无开发库迁移/初始化或数据重置。

## S4n 报销列表索引与快照

015_reimbursement_list_index.sql仅新增applications_reimbursement_applicant_created_idx，在applications(applicant_id,created_at DESC,id)上以type='reimbursement'限定。与草稿按更新时间的索引互补；当前任务/已办继续复用既有approval_tasks索引，未改旧迁移、字段、触发器或历史数据。

申请和任务列表各以一个SQL读取匹配结果、分页总数、当前任务、申请版本、NUMERIC金额及显式无票数。身份/有效部门检查在事务与组织锁下完成；列表不取申请行锁，不改变通知或业务数据，跨请求不承诺同一状态，也不预留后续动作。空明细或有缺金额时合计null，已提交名称使用冻结快照，不读取关联源正文。

开发库015已应用并重复验证：20张既有业务表全部行内容摘要在迁移前后保持（schema_migrations版本记录除外）；新索引存在，没有重置/seed或操作私有文件。独立approval_test完整回归与HTTP串行通过；新环境迁移001–015即可，备份仍须数据库/附件配对。

## S4r 固定报销重提来源

016_reimbursement_resubmission.sql只CREATE OR REPLACE既有preserve_travel_resubmission()函数，将固定类型白名单从travel/purchase扩为travel/purchase/reimbursement，触发器身份及旧链不变。008的resubmission_of列、唯一直接后续、自引用检查、ON DELETE RESTRICT和012的不可变约束继续使用；重提新报销由013/014保护费用、链接和票据归属，不改旧迁移校验和。

复制事务先组织/身份/部门锁，再原报销FOR UPDATE；若有后续取SHARE后直接返回。首次复制对关联采购/差旅按UUID排序持SHARE并重验资格，接着创建新主表/报销头/新费用/链接，失败全部回滚。原版本/时间/执行记录和私有对象不动。新草稿采用当前部门，无票原因保留但票据记录/号码/原文件不复制；提交仍走完整文件/来源校验。GET关系仅本人终态，持原单/后续SHARE，关系不会授予跨单权限。

新环境迁移001–016，已有库只追加迁移，不重置/seed。开发库迁移前后内容摘要及重复应用结果以STATUS.md/开发日志为准；测试仅使用approval_test及隔离文件目录，数据库与附件备份配套要求不变。

## S4s 固定业务统计索引与读取

017_fixed_statistics_indexes.sql新增applications_fixed_department_submitted_idx和applications_fixed_applicant_submitted_idx，分别按department_id/submitted_at/type/status与applicant_id/submitted_at/type/status索引，仅含submitted_at非空且固定三类型。无新业务表或授权表，不改旧迁移、业务行或文件；新环境执行001–017。

统计事务先组织72002共享锁及会话/有效部门检查，部门范围按锁后当前department_head/departmentId决定。所有业务数量/当前状态/NUMERIC金额和本人实际待办共用单SQL快照，不取申请行锁；部门按applications保存的部门而非用户现部门。金额按单先聚合，避免明细/来源/任务连接倍增，多单总额不收窄回14位。未知金额显式返回null/缺失单数。

017开发库追加、20张业务表行数/全行摘要前后比较及重复迁移结果见STATUS.md；不重置/seed。测试与HTTP串行使用approval_test及隔离目录，数据库/附件仍需配对备份。本阶段不实现自定义流程或额外财务/公司统计授权。
