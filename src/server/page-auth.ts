import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "./auth";
import { cookieName } from "./http";
import { ApiError } from "./errors";
import { transaction } from "./db";
import { requireBusinessActor } from "./business-auth";
export async function pageUser() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  try {
    return await requireUser(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
export async function requirePageUser(admin = false) {
  const user = await pageUser();
  if (!user) redirect("/login?expired=1");
  if (
    admin &&
    (user.status !== "active" || !user.roles.includes("system_admin"))
  )
    redirect("/account?denied=1");
  return user;
}

export async function requireBusinessPageUser() {
  const token = (await cookies()).get(cookieName)?.value;
  try {
    return await transaction((client) => requireBusinessActor(token, client));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect("/login?expired=1");
    if (error instanceof ApiError && error.status === 403)
      redirect("/account?businessDenied=1");
    throw error;
  }
}
