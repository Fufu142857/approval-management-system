import { z } from "zod";

export const roleCodes = [
  "employee",
  "department_head",
  "finance_approver",
  "company_head",
  "system_admin",
] as const;

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{2,31}$/);
export const registerSchema = z.strictObject({
  username,
  fullName: z.string().trim().min(1).max(80),
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  requestedDepartmentId: z.uuid(),
});
export const loginSchema = z.strictObject({
  username,
  password: z.string().min(1).max(128),
  client: z.enum(["web", "mobile"]).default("web"),
});
export const accessSchema = z.strictObject({
  departmentId: z.uuid(),
  status: z.enum(["active", "disabled"]),
  roles: z
    .array(z.enum(roleCodes))
    .min(1)
    .max(5)
    .refine(
      (roles) =>
        roles.includes("employee") && new Set(roles).size === roles.length,
      "角色必须包含 employee 且不能重复",
    ),
  reason: z.string().trim().min(1).max(500),
});
export const pageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const userListSchema = pageSchema.extend({
  status: z.enum(["pending", "active", "disabled"]).optional(),
});

export type UserIdentity = {
  id: string;
  username: string;
  fullName: string;
  email: string;
  requestedDepartmentId: string;
  departmentId: string | null;
  status: "pending" | "active" | "disabled";
  roles: (typeof roleCodes)[number][];
};
