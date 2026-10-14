import { database } from "./db";
import type { Department } from "../lib/identity-display";
export async function listDepartments() {
  return (
    await database().query<Department>(
      "SELECT id,name FROM departments WHERE active ORDER BY name,id",
    )
  ).rows;
}
