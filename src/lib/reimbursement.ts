import { z } from "zod";
import { pageSchema } from "./identity";
import { draftVersionSchema } from "./travel";

export const reimbursementCategories = [
  "transport",
  "lodging",
  "meals",
  "office",
  "other",
] as const;
const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/, "金额最多十二位整数和两位小数")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  })
  .refine((value) => value !== "0.00", "金额必须大于零");
const item = z.strictObject({
  id: z.uuid().optional(),
  category: z.enum(reimbursementCategories).nullable().default(null),
  expenseDate: z.iso
    .date()
    .refine((value) => value >= "0001-01-01", "日期无效")
    .nullable()
    .default(null),
  purpose: z.string().trim().max(2000).default(""),
  amount: money.nullable().default(null),
  noReceipt: z.boolean().default(false),
  noReceiptReason: z.string().trim().max(2000).default(""),
});
const fields = {
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(2000).default(""),
  independentReason: z.string().trim().max(2000).default(""),
  remarks: z.string().trim().max(2000).default(""),
  linkedApplicationIds: z.array(z.uuid()).max(20).default([]),
  items: z.array(item).max(100).default([]),
};
function check(
  input: z.infer<ReturnType<typeof baseSchema>>,
  ctx: z.RefinementCtx,
) {
  const ids = input.items.flatMap((row) => (row.id ? [row.id] : []));
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "费用明细 ID 不能重复",
    });
  if (
    new Set(input.linkedApplicationIds).size !==
    input.linkedApplicationIds.length
  )
    ctx.addIssue({
      code: "custom",
      path: ["linkedApplicationIds"],
      message: "关联申请不能重复",
    });
  const total = input.items.reduce(
    (sum, row) =>
      sum +
      (row.amount && /^\d+\.\d{2}$/.test(row.amount)
        ? BigInt(row.amount.replace(".", ""))
        : 0n),
    0n,
  );
  if (total > 99999999999999n)
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "报销合计超过上限",
    });
}
function baseSchema() {
  return z.strictObject(fields);
}
export const reimbursementDraftSchema = baseSchema().superRefine(check);
export const replaceReimbursementDraftSchema = z
  .strictObject({ ...fields, ...draftVersionSchema.shape })
  .superRefine(check);
export const reimbursementDraftListSchema = pageSchema.extend({
  keyword: z.string().trim().max(200).default(""),
});
export const reimbursementLinkOptionsSchema =
  reimbursementDraftListSchema.extend({
    type: z.enum(["travel", "purchase"]).optional(),
  });
export type ReimbursementDraftInput = z.infer<typeof reimbursementDraftSchema>;
export type ReplaceReimbursementDraftInput = z.infer<
  typeof replaceReimbursementDraftSchema
>;
export type ReimbursementLinkSummary = {
  id: string;
  appNo: string;
  title: string;
  type: "travel" | "purchase";
  status: "approved";
  submittedAt: string;
  departmentId: string;
};
export type ReimbursementLinkedApplication = ReimbursementLinkSummary & {
  travel: {
    departure: string;
    destination: string;
    startDate: string;
    endDate: string;
    durationDays: number;
    budget: string;
  } | null;
  purchase: { budgetLimit: string; totalAmount: string } | null;
};
export type ReimbursementDraft = Omit<ReimbursementDraftInput, "items"> & {
  id: string;
  appNo: string;
  applicantId: string;
  departmentId: string;
  type: "reimbursement";
  status: "draft";
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: null;
  totalAmount: string | null;
  noReceiptCount: number;
  items: (Omit<ReimbursementDraftInput["items"][number], "id"> & {
    id: string;
  })[];
  linkedApplications: ReimbursementLinkedApplication[];
};
export type ReimbursementDraftSummary = Pick<
  ReimbursementDraft,
  | "id"
  | "appNo"
  | "title"
  | "type"
  | "status"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "totalAmount"
  | "noReceiptCount"
>;
