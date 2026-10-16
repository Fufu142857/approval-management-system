import Link from "next/link";
import { Icon } from "@/components/icons";
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="auth-layout">
      <section className="auth-content" aria-label="账号入口">
        <Link href="/" className="brand">
          <Icon name="grid" />
          <span>审批管理系统</span>
        </Link>
        {children}
      </section>
    </main>
  );
}
