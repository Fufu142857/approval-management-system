import { z } from "zod";
import { pageSchema } from "./identity";

export const travelStatuses = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
const filters = pageSchema.extend({
  type: z.literal("travel").default("travel"),
  status: z.enum(["all", ...travelStatuses]).default("all"),
  keyword: z.string().trim().max(200).default(""),
  from: date.optional(),
  to: date.optional(),
});
function ordered(input: { from?: string; to?: string }) {
  return !input.from || !input.to || input.from <= input.to;
}
const rangeError = { message: "结束日期不能早于开始日期", path: ["to"] };
export const travelApplicationListSchema = filters.refine(ordered, rangeError);
export const travelTaskListSchema = filters
  .extend({
    state: z.enum(["pending", "handled"]).default("pending"),
  })
  .refine(ordered, rangeError);
export type TravelApplicationListInput = z.infer<
  typeof travelApplicationListSchema
>;
export type TravelTaskListInput = z.infer<typeof travelTaskListSchema>;
export type TravelApplicationSummary = {
  id: string;
  appNo: string;
  type: "travel";
  title: string;
  status: (typeof travelStatuses)[number];
  version: number;
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
export type TravelTaskSummary = {
  id: string;
  seqNo: number;
  name: string;
  status: "pending" | "approved" | "rejected";
  activatedAt: string;
  finishedAt: string | null;
  application: TravelApplicationSummary;
};
export type TravelList<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
