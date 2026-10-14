"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { UserIdentity } from "@/lib/identity";
import { api, errorMessage, RequestError } from "@/lib/api-client";
import { Notice } from "./ui";

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
  const admin = user.status === "active" && user.roles.includes("system_admin");
  const links = [
    { href: "/account", label: "个人信息" },
    ...(admin
      ? [
          { href: "/admin/users", label: "用户管理" },
          { href: "/admin/audit", label: "操作审计" },
        ]
      : []),
  ];
  return (
    <>
      <a href="#main" className="skip-link">
        跳到主要内容
      </a>
      <header className="topbar">
        <Link href="/account" className="brand" prefetch={false}>
          <span className="brand-mark" aria-hidden="true">
            序
          </span>
          <span>
            审批管理系统<small>组织与身份</small>
          </span>
        </Link>
        <div className="user-menu">
          <span>{user.fullName}</span>
          <button
            className="button secondary compact"
            onClick={logout}
            disabled={busy}
          >
            {busy ? "退出中…" : "退出登录"}
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <p className="eyebrow">工作空间</p>
          <nav aria-label="主导航">
            {links.map((link) => (
              <Link
                key={link.href}
                prefetch={false}
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
              >
                {link.label}
                <span aria-hidden="true">↗</span>
              </Link>
            ))}
          </nav>
          <p className="sidebar-note">
            清晰的身份
            <br />
            有据可查的权限
          </p>
        </aside>
        <main id="main" className="main-content">
          {error && <Notice error>{error}</Notice>}
          {children}
        </main>
      </div>
    </>
  );
}
