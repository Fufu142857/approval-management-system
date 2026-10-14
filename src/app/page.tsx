import { redirect } from "next/navigation";
import { pageUser } from "@/server/page-auth";
export default async function HomePage() {
  redirect((await pageUser()) ? "/account" : "/login");
}
