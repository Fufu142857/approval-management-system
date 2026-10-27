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
  // TODO(S5-人工): 自定义申请通知接入时，自行补充目标类型，并与服务端授权及页面跳转保持一致。
  target: {
    type: "travel" | "purchase" | "reimbursement";
    id: string;
    status: string;
    apiPath: string;
  } | null;
  task: { id: string; status: string } | null;
};
