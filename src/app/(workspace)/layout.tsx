import { requirePageUser } from "@/server/page-auth";
import { AccountShell } from "@/components/account-shell";
export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AccountShell user={await requirePageUser()}>{children}</AccountShell>;
}
