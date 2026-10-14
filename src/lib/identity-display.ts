import type { UserIdentity } from "./identity";
export const roleNames: Record<UserIdentity["roles"][number], string> = {
  employee: "普通员工",
  department_head: "部门负责人",
  finance_approver: "财务审批人",
  company_head: "企业负责人",
  system_admin: "系统管理员",
};
export const statusNames = {
  pending: "待确认",
  active: "已启用",
  disabled: "已停用",
};
export type Department = { id: string; name: string };
export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
