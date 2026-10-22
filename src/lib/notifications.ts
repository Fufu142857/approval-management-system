import { z } from "zod";
import { pageSchema } from "./identity";

export const notificationListSchema = pageSchema.extend({
  state: z.enum(["all", "unread", "read"]).default("all"),
});
export const emptyNotificationSchema = z.strictObject({});
export type NotificationListInput = z.infer<typeof notificationListSchema>;
export type NotificationItem = {
  id: string;
  appId: string;
  kind:
    | "approval.pending"
    | "application.approved"
    | "application.rejected"
    | "application.withdrawn";
  title: string;
  createdAt: string;
  readAt: string | null;
  target: {
    type: "travel" | "purchase" | "reimbursement";
    id: string;
    status: string;
    apiPath: string;
  } | null;
  task: { id: string; status: string } | null;
};
