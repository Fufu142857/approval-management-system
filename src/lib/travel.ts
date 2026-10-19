import { z } from "zod";
import { pageSchema } from "./identity";

// Calendar dates in Asia/Shanghai, not instants converted through the browser timezone.
const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
const budget = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/,
    "预算须为非负金额，最多两位小数和十二位整数",
  )
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });
const draftFields = {
  title: z.string().trim().max(200).default(""),
  departure: z.string().trim().max(200).default(""),
  destination: z.string().trim().max(200).default(""),
  startDate: date.nullable().default(null),
  endDate: date.nullable().default(null),
  purpose: z.string().trim().max(2000).default(""),
  companions: z.string().trim().max(1000).default(""),
  transportation: z.string().trim().max(100).default(""),
  budget: budget.nullable().default(null),
  remarks: z.string().trim().max(2000).default(""),
};
function datesOrdered(input: {
  startDate: string | null;
  endDate: string | null;
}) {
  return !input.startDate || !input.endDate || input.endDate >= input.startDate;
}
const dateError = { message: "结束日期不能早于开始日期", path: ["endDate"] };
export const travelDraftSchema = z
  .strictObject(draftFields)
  .refine(datesOrdered, dateError);
// Validate persisted fixed fields again at submission; optional companions/remarks stay optional.
export const completeTravelSchema = z
  .strictObject({
    ...draftFields,
    title: draftFields.title.removeDefault().min(1),
    departure: draftFields.departure.removeDefault().min(1),
    destination: draftFields.destination.removeDefault().min(1),
    purpose: draftFields.purpose.removeDefault().min(1),
    transportation: draftFields.transportation.removeDefault().min(1),
    startDate: date,
    endDate: date,
    budget,
  })
  .refine(datesOrdered, dateError);
export const draftVersionSchema = z.strictObject({
  version: z.number().int().min(1).max(2147483647),
});
// PUT replaces editable fields; omission clears a field. Version is mandatory.
export const replaceTravelDraftSchema = z
  .strictObject({ ...draftFields, ...draftVersionSchema.shape })
  .refine(datesOrdered, dateError);
export const travelDraftListSchema = pageSchema.extend({
  keyword: z.string().trim().max(200).default(""),
});
export type TravelDraftInput = z.infer<typeof travelDraftSchema>;
export type ReplaceTravelDraftInput = z.infer<typeof replaceTravelDraftSchema>;
export type TravelDraft = TravelDraftInput & {
  id: string;
  appNo: string;
  applicantId: string;
  resubmissionOf: string | null;
  departmentId: string;
  type: "travel";
  status: "draft";
  version: number;
  durationDays: number | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: null;
};

export type TravelApplication = Omit<TravelDraft, "status" | "submittedAt"> & {
  status: "pending" | "approved" | "rejected" | "withdrawn";
  submittedAt: string;
};
