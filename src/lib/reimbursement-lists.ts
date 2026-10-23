import { z } from "zod";
import { pageSchema } from "./identity";

export const reimbursementStatuses = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
const filters = pageSchema.extend({
  type: z.literal("reimbursement").default("reimbursement"),
  status: z.enum(["all", ...reimbursementStatuses]).default("all"),
  keyword: z.string().trim().max(200).default(""),
  from: date.optional(),
  to: date.optional(),
});
function ordered(input: { from?: string; to?: string }) {
  return !input.from || !input.to || input.from <= input.to;
}
const rangeError = { message: "结束日期不能早于开始日期", path: ["to"] };
export const reimbursementApplicationListSchema = filters.refine(
  ordered,
  rangeError,
);
export const reimbursementTaskListSchema = filters
  .extend({
    state: z.enum(["pending", "handled"]).default("pending"),
  })
  .refine(ordered, rangeError);
export type ReimbursementApplicationListInput = z.infer<
  typeof reimbursementApplicationListSchema
>;
export type ReimbursementTaskListInput = z.infer<
  typeof reimbursementTaskListSchema
>;
export type ReimbursementApplicationSummary = {
  id: string;
  appNo: string;
  type: "reimbursement";
  title: string;
  status: (typeof reimbursementStatuses)[number];
  version: number;
  totalAmount: string | null;
  noReceiptCount: number;
  applicant: {
    id: string;
    name: string;
    departmentId: string;
    departmentName: string;
  };
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  currentTask: {
    id: string;
    seqNo: number;
    name: string;
    approver: { id: string; name: string };
  } | null;
};
export type ReimbursementTaskSummary = {
  id: string;
  seqNo: number;
  name: string;
  status: "pending" | "approved" | "rejected";
  activatedAt: string;
  finishedAt: string | null;
  application: ReimbursementApplicationSummary;
};
export type ReimbursementList<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
