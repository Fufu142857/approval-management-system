import { z } from "zod";

export const statisticsTypes = ["travel", "purchase", "reimbursement"] as const;
export const statisticsStatuses = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
const date = z.iso.date().refine((value) => value >= "0001-01-01", "日期无效");
export const statisticsSchema = z
  .strictObject({
    scope: z.enum(["personal", "department"]).default("personal"),
    departmentId: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    type: z.enum(["all", ...statisticsTypes]).default("all"),
    from: date.optional(),
    to: date.optional(),
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "结束日期不能早于开始日期",
    path: ["to"],
  });
export type StatisticsInput = z.infer<typeof statisticsSchema>;
export type StatisticsType = (typeof statisticsTypes)[number];
export type StatisticsCounts = {
  total: number;
  statuses: Record<(typeof statisticsStatuses)[number], number>;
};
export type FixedBusinessStatistics = {
  filters: {
    scope: StatisticsInput["scope"];
    departmentId: string | null;
    type: StatisticsInput["type"];
    from: string | null;
    to: string | null;
    timeBasis: "submittedAt";
    timezone: "Asia/Shanghai";
  };
  applications: StatisticsCounts & {
    byType: (StatisticsCounts & {
      type: StatisticsType;
      approvedAmount: string | null;
      approvedAmountMissingCount: number;
    })[];
  };
  // Always the caller's actual active tasks, never all tasks of a department.
  pendingTasks: {
    total: number;
    byType: { type: StatisticsType; count: number }[];
  };
};
