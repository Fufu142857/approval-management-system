import { z } from "zod";
import { pageSchema } from "./identity";

export const purchaseStatuses = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
const filters = pageSchema.extend({
  type: z.literal("purchase").default("purchase"),
  status: z.enum(["all", ...purchaseStatuses]).default("all"),
  keyword: z.string().trim().max(200).default(""),
  from: date.optional(),
  to: date.optional(),
});
function ordered(input: { from?: string; to?: string }) {
  return !input.from || !input.to || input.from <= input.to;
}
const rangeError = { message: "结束日期不能早于开始日期", path: ["to"] };
export const purchaseApplicationListSchema = filters.refine(
  ordered,
  rangeError,
);
export const purchaseTaskListSchema = filters
  .extend({
    state: z.enum(["pending", "handled"]).default("pending"),
  })
  .refine(ordered, rangeError);
export type PurchaseApplicationListInput = z.infer<
  typeof purchaseApplicationListSchema
>;
export type PurchaseTaskListInput = z.infer<typeof purchaseTaskListSchema>;
export type PurchaseApplicationSummary = {
  id: string;
  appNo: string;
  type: "purchase";
  title: string;
  status: (typeof purchaseStatuses)[number];
  version: number;
  budgetLimit: string | null;
  totalAmount: string | null;
  singleSource: boolean;
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
export type PurchaseTaskSummary = {
  id: string;
  seqNo: number;
  name: string;
  status: "pending" | "approved" | "rejected";
  activatedAt: string;
  finishedAt: string | null;
  application: PurchaseApplicationSummary;
};
export type PurchaseList<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
