import { z } from "zod";
import { pageSchema } from "./identity";
import { draftVersionSchema } from "./travel";

const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/, "金额最多十二位整数和两位小数")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });
const positiveMoney = money.refine(
  (value) => value !== "0.00",
  "金额必须大于零",
);
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/, "数量最多九位整数和三位小数")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(3, "0")}`;
  })
  .refine((value) => value !== "0.000", "数量必须大于零");
const purchaseUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "购买链接须为不含账号密码的 HTTP(S) 地址")
  .default("");
const item = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().max(200).default(""),
  specification: z.string().trim().max(500).default(""),
  quantity: quantity.nullable().default(null),
  unit: z.string().trim().max(40).default(""),
  unitPrice: positiveMoney.nullable().default(null),
});
const quote = z.strictObject({
  id: z.uuid().optional(),
  supplierName: z.string().trim().max(200).default(""),
  quoteDate: date.nullable().default(null),
  amount: positiveMoney.nullable().default(null),
  basis: z.string().trim().max(2000).default(""),
  purchaseUrl,
  isOnline: z.boolean().default(false),
  selected: z.boolean().default(false),
});
const fields = {
  title: z.string().trim().max(200).default(""),
  reason: z.string().trim().max(2000).default(""),
  expectedDate: date.nullable().default(null),
  project: z.string().trim().max(200).default(""),
  budgetLimit: money.nullable().default(null),
  selectionReason: z.string().trim().max(2000).default(""),
  singleSource: z.boolean().default(false),
  singleSourceReason: z.string().trim().max(2000).default(""),
  remarks: z.string().trim().max(2000).default(""),
  items: z.array(item).max(100).default([]),
  quotes: z.array(quote).max(20).default([]),
};
// Quantity uses thousandths; price uses cents. Round each line half-up to cents, then sum.
export function purchaseLineCents(item: {
  quantity: string | null;
  unitPrice: string | null;
}) {
  if (item.quantity === null || item.unitPrice === null) return null;
  return (
    (BigInt(item.quantity.replace(".", "")) *
      BigInt(item.unitPrice.replace(".", "")) +
      500n) /
    1000n
  );
}
const maxCents = 99999999999999n;
function checkRows(
  input: z.infer<ReturnType<typeof baseSchema>>,
  ctx: z.RefinementCtx,
) {
  const ids = new Set<string>();
  for (const key of ["items", "quotes"] as const) {
    input[key].forEach((row, index) => {
      if (row.id && ids.has(row.id))
        ctx.addIssue({
          code: "custom",
          path: [key, index, "id"],
          message: "明细 ID 不能重复",
        });
      if (row.id) ids.add(row.id);
    });
  }
  if (input.quotes.filter((row) => row.selected).length > 1)
    ctx.addIssue({
      code: "custom",
      path: ["quotes"],
      message: "只能选择一家供应商",
    });
  let total = 0n;
  input.items.forEach((row, index) => {
    // A previous string validation failure must not reach BigInt.
    if (
      (row.quantity !== null && !/^\d+\.\d{3}$/.test(row.quantity)) ||
      (row.unitPrice !== null && !/^\d+\.\d{2}$/.test(row.unitPrice))
    )
      return;
    const cents = purchaseLineCents(row);
    if (cents !== null) {
      total += cents;
      if (cents > maxCents)
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: "明细金额超过上限",
        });
    }
  });
  if (total > maxCents)
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "采购总额超过上限",
    });
}
function baseSchema() {
  return z.strictObject(fields);
}
export const purchaseDraftSchema = baseSchema().superRefine(checkRows);
export const replacePurchaseDraftSchema = z
  .strictObject({ ...fields, ...draftVersionSchema.shape })
  .superRefine(checkRows);
export const purchaseDraftListSchema = pageSchema.extend({
  keyword: z.string().trim().max(200).default(""),
});
export type PurchaseDraftInput = z.infer<typeof purchaseDraftSchema>;
export type ReplacePurchaseDraftInput = z.infer<
  typeof replacePurchaseDraftSchema
>;
export type PurchaseDraft = Omit<PurchaseDraftInput, "items" | "quotes"> & {
  id: string;
  appNo: string;
  applicantId: string;
  departmentId: string;
  type: "purchase";
  status: "draft";
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: null;
  totalAmount: string | null;
  items: (Omit<PurchaseDraftInput["items"][number], "id"> & {
    id: string;
    amount: string | null;
  })[];
  quotes: (Omit<PurchaseDraftInput["quotes"][number], "id"> & { id: string })[];
};
export type PurchaseDraftSummary = Pick<
  PurchaseDraft,
  | "id"
  | "appNo"
  | "title"
  | "type"
  | "status"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "budgetLimit"
  | "totalAmount"
  | "singleSource"
>;

export type PurchaseRecord = Omit<PurchaseDraft, "status" | "submittedAt"> & {
  status: "draft" | "pending" | "approved" | "rejected" | "withdrawn";
  submittedAt: string | null;
};
