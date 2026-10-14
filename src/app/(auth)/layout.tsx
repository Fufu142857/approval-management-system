import Link from "next/link";
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="auth-layout">
      <aside className="auth-brand">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            序
          </span>
          <span>审批管理系统</span>
        </Link>
        <div>
          <p className="eyebrow">组织 · 身份 · 权限</p>
          <h2>
            协作的起点，
            <br />
            是清晰的身份。
          </h2>
          <p>
            统一账号与部门归属，
            <br />
            让每一项授权都有据可查。
          </p>
        </div>
        <p className="auth-footnote">你的权限由组织管理员确认和维护。</p>
      </aside>
      <section className="auth-content" aria-label="账号入口">
        {children}
      </section>
    </main>
  );
}
