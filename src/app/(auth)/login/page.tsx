import { redirect } from "next/navigation";
import { pageUser } from "@/server/page-auth";
import { AuthForm } from "@/components/auth-form";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string }>;
}) {
  if (await pageUser()) redirect("/account");
  return (
    <AuthForm mode="login" expired={(await searchParams).expired === "1"} />
  );
}
