import Link from "next/link";
import { requirePageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { roleNames } from "@/lib/identity-display";
import { Notice, StatusBadge } from "@/components/ui";
import { RefreshAccount } from "@/components/account-shell";
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; businessDenied?: string }>;
}) {
  const user = await requirePageUser();
  const departments = await listDepartments();
  const departmentName = (id: string | null) =>
    departments.find((d) => d.id === id)?.name ?? "尚未确认";
  return (
    <div className="stack large-gap">
      <header className="page-heading">
        <div>
          <h2>{user.fullName}</h2>
        </div>
        <StatusBadge status={user.status} />
      </header>
      {(await searchParams).denied === "1" && (
        <Notice error>你没有管理权限，请联系组织管理员。</Notice>
      )}
      {(await searchParams).businessDenied === "1" && (
        <Notice error>
          账号或所属部门尚不可用，请联系管理员确认后再办理申请。
        </Notice>
      )}
      {user.status === "pending" && (
        <Notice>
          <strong>等待管理员确认</strong>
          <p>账号已创建。管理员将核对你的部门并分配权限；确认后请重新登录。</p>
          <RefreshAccount />
        </Notice>
      )}
      <div className="profile-grid">
        <section className="panel">
          <h2>基本资料</h2>
          <dl className="detail-list">
            <div>
              <dt>用户名</dt>
              <dd>{user.username}</dd>
            </div>
            <div>
              <dt>姓名</dt>
              <dd>{user.fullName}</dd>
            </div>
            <div>
              <dt>邮箱</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>申请部门</dt>
              <dd>{departmentName(user.requestedDepartmentId)}</dd>
            </div>
            <div>
              <dt>确认部门</dt>
              <dd>{departmentName(user.departmentId)}</dd>
            </div>
          </dl>
        </section>
        <section className="panel">
          <h2>角色与权限</h2>
          <p className="muted">当前角色由管理员分配。</p>
          <div className="role-tags">
            {user.roles.map((role) => (
              <span className="role-tag" key={role}>
                {roleNames[role]}
              </span>
            ))}
          </div>
          <p className="hint">
            如需更正部门或调整权限，请联系管理员。系统管理权限不等于业务审批权限。
          </p>
          {user.status === "active" && user.roles.includes("system_admin") && (
            <Link
              href="/admin/users"
              prefetch={false}
              className="button secondary"
            >
              进入用户管理 →
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}
