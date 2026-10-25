"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { UserIdentity } from "@/lib/identity";
import { api, errorMessage, RequestError } from "@/lib/api-client";
import { Notice } from "./ui";
import { useForegroundResource } from "./use-foreground-resource";
import { NotificationContext } from "./notification-context";
import { Icon, type IconName } from "./icons";

export function RefreshAccount() {
  return (
    <button className="text-button" onClick={() => window.location.reload()}>
      重新查看账号状态 →
    </button>
  );
}
export function AccountShell({
  user,
  children,
}: {
  user: UserIdentity;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        await api("/auth/me");
      } catch (error) {
        if (active && error instanceof RequestError && error.status === 401)
          window.location.replace("/login?expired=1");
      }
    }
    void checkSession();
    const timer = window.setInterval(checkSession, 60000);
    window.addEventListener("focus", checkSession);
    window.addEventListener("pageshow", checkSession);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", checkSession);
      window.removeEventListener("pageshow", checkSession);
    };
  }, []);
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await api("/auth/logout", { method: "POST" });
      window.location.replace("/login");
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  const notificationsEnabled =
    user.status === "active" && !!user.departmentId && !busy;
  const unread = useForegroundResource<{ unreadCount: number }>(
    "/notifications/unread-count",
    notificationsEnabled,
    false,
  );
  const notifications =
    pathname === "/notifications" || pathname.startsWith("/notifications/");
  const admin = user.status === "active" && user.roles.includes("system_admin");
  const futureLinks: { label: string; icon: IconName }[] = [
    { label: "工作台", icon: "home" },
    { label: "我的申请", icon: "document" },
    { label: "我的待办", icon: "task" },
    { label: "通知中心", icon: "bell" },
    { label: "查询统计", icon: "chart" },
  ];
  const management = pathname.startsWith("/admin/");
  const reimbursement = pathname.startsWith("/reimbursement/");
  const purchase = pathname.startsWith("/purchase/");
  const travel = pathname.startsWith("/travel/");
  const taskList =
    pathname.startsWith("/travel/tasks") ||
    pathname.startsWith("/purchase/tasks") ||
    pathname.startsWith("/reimbursement/tasks");
  const title =
    pathname === "/statistics"
      ? "查询统计"
      : reimbursement
        ? taskList
          ? "我的待办"
          : ["/reimbursement/drafts", "/reimbursement/applications"].includes(
                pathname,
              )
            ? "我的申请"
            : pathname.startsWith("/reimbursement/applications/")
              ? "报销申请详情"
              : "报销申请"
        : purchase
          ? taskList
            ? "我的待办"
            : ["/purchase/drafts", "/purchase/applications"].includes(pathname)
              ? "我的申请"
              : pathname.startsWith("/purchase/applications/")
                ? "采购申请详情"
                : "采购申请"
          : notifications
            ? pathname === "/notifications"
              ? "通知中心"
              : "通知详情"
            : taskList
              ? "我的待办"
              : travel
                ? ["/travel/drafts", "/travel/applications"].includes(pathname)
                  ? "我的申请"
                  : pathname.startsWith("/travel/applications/")
                    ? "差旅申请详情"
                    : "差旅申请"
                : pathname === "/admin/users"
                  ? "用户管理"
                  : pathname === "/admin/audit"
                    ? "操作审计"
                    : "个人信息";
  const subtitle =
    pathname === "/statistics"
      ? "查看申请状态、本人待办与分类金额"
      : reimbursement
        ? taskList
          ? "处理报销审批任务，查看已办记录"
          : ["/reimbursement/drafts", "/reimbursement/applications"].includes(
                pathname,
              )
            ? "查询本人报销申请，管理草稿与审批进度"
            : pathname.startsWith("/reimbursement/applications/")
              ? "查看费用、关联来源、票据与审批记录"
              : "填写费用、关联已批申请并提交报销"
        : purchase
          ? taskList
            ? "处理采购审批任务，查看已办记录"
            : ["/purchase/drafts", "/purchase/applications"].includes(pathname)
              ? "查询本人采购申请，管理草稿与审批进度"
              : pathname.startsWith("/purchase/applications/")
                ? "查看采购内容、审批进度与历史记录"
                : "填写采购信息，提交后进入审批流程"
          : notifications
            ? "查看待办与审批结果，管理阅读状态"
            : taskList
              ? "处理当前审批任务，查看已办记录"
              : travel
                ? ["/travel/drafts", "/travel/applications"].includes(pathname)
                  ? "查询本人申请，管理草稿与审批进度"
                  : pathname.startsWith("/travel/applications/")
                    ? "查看申请内容、审批进度与历史记录"
                    : "填写差旅信息，提交后进入审批流程"
                : pathname === "/admin/users"
                  ? "维护用户的部门归属与角色权限"
                  : pathname === "/admin/audit"
                    ? "查看授权与配置变更记录"
                    : "查看个人资料、部门与角色权限";
  return (
    <NotificationContext
      value={{ enabled: notificationsEnabled, refreshCount: unread.refresh }}
    >
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <div className="app-frame">
        <aside className="sidebar">
          <Link href="/account" className="brand" prefetch={false}>
            <Icon name="grid" />
            <span>审批管理系统</span>
          </Link>
          <nav aria-label="主导航">
            {futureLinks.map((link) =>
              ["我的申请", "我的待办", "通知中心", "查询统计"].includes(
                link.label,
              ) && user.status === "active" ? (
                <Link
                  key={link.label}
                  className="nav-item"
                  href={
                    link.label === "查询统计"
                      ? "/statistics"
                      : link.label === "我的申请"
                        ? reimbursement
                          ? "/reimbursement/applications"
                          : purchase
                            ? "/purchase/applications"
                            : "/travel/applications"
                        : link.label === "我的待办"
                          ? reimbursement
                            ? "/reimbursement/tasks"
                            : purchase
                              ? "/purchase/tasks"
                              : "/travel/tasks"
                          : "/notifications"
                  }
                  prefetch={false}
                  aria-current={
                    (
                      link.label === "查询统计"
                        ? pathname === "/statistics"
                        : link.label === "通知中心"
                          ? notifications
                          : link.label === "我的待办"
                            ? taskList
                            : (travel || purchase || reimbursement) && !taskList
                    )
                      ? "page"
                      : undefined
                  }
                >
                  <Icon name={link.icon} />
                  {link.label}
                  {link.label === "通知中心" && (
                    <span
                      className="notification-count"
                      aria-label={
                        unread.error
                          ? "未读数暂不可用"
                          : `未读通知 ${unread.data?.unreadCount ?? "加载中"}`
                      }
                      title={unread.error ?? "本人全部未读通知"}
                    >
                      {unread.error ? "—" : (unread.data?.unreadCount ?? "…")}
                    </span>
                  )}
                </Link>
              ) : (
                <span
                  key={link.label}
                  className="nav-item"
                  aria-disabled="true"
                  title={`${link.label}尚未开放`}
                >
                  <Icon name={link.icon} />
                  {link.label}
                </span>
              ),
            )}
            {admin && (
              <div className="nav-divider">
                <Link
                  className="nav-item"
                  prefetch={false}
                  href="/admin/users"
                  aria-current={management ? "page" : undefined}
                >
                  <Icon name="settings" />
                  管理后台
                </Link>
              </div>
            )}
          </nav>
        </aside>
        <header className="topbar">
          <div className="topbar-heading">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="topbar-tools">
            <div className="search-placeholder" title="全局搜索尚未开放">
              <Icon name="search" />
              <input
                aria-label="搜索申请、流程或人员"
                placeholder="搜索申请、流程或人员..."
                disabled
              />
            </div>
            <details
              className="user-menu"
              key={pathname}
              onKeyDown={(event) => {
                if (event.key === "Escape")
                  event.currentTarget.removeAttribute("open");
              }}
            >
              <summary aria-label="用户菜单">
                <span className="avatar">
                  <Icon name="user" />
                </span>
                <span className="user-name">{user.fullName}</span>
                <Icon name="chevron" />
              </summary>
              <div className="user-dropdown">
                <Link href="/account" prefetch={false}>
                  个人信息
                </Link>
                <button onClick={logout} disabled={busy}>
                  {busy ? "退出中…" : "退出登录"}
                </button>
              </div>
            </details>
          </div>
        </header>
        <main id="main" className="main-content">
          {admin && management && (
            <nav className="management-tabs" aria-label="管理后台导航">
              <Link
                href="/admin/users"
                prefetch={false}
                aria-current={pathname === "/admin/users" ? "page" : undefined}
              >
                用户管理
              </Link>
              <Link
                href="/admin/audit"
                prefetch={false}
                aria-current={pathname === "/admin/audit" ? "page" : undefined}
              >
                操作审计
              </Link>
            </nav>
          )}
          {error && <Notice error>{error}</Notice>}
          {children}
        </main>
      </div>
    </NotificationContext>
  );
}
