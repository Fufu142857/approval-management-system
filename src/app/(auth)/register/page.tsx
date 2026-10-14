import { redirect } from "next/navigation";
import { pageUser } from "@/server/page-auth";
import { listDepartments } from "@/server/organization";
import { AuthForm } from "@/components/auth-form";
export default async function RegisterPage() {
  if (await pageUser()) redirect("/account");
  return <AuthForm mode="register" departments={await listDepartments()} />;
}
