import { z } from "zod";
import {
  emptyNotificationSchema,
  notificationListSchema,
} from "../lib/notifications";
import {
  getNotification,
  listNotifications,
  markNotificationRead,
  unreadNotificationCount,
} from "./notifications";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";

type Context = { params: Promise<{ id: string }> };
const query = (request: Request) =>
  Object.fromEntries(new URL(request.url).searchParams);
export function notificationsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listNotifications(
        requestToken(request),
        notificationListSchema.parse(query(request)),
      ),
    ),
  );
}
export function notificationHandler(request: Request, context: Context) {
  return endpoint(async () => {
    emptyNotificationSchema.parse(query(request));
    return data(
      await getNotification(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function unreadNotificationsHandler(request: Request) {
  return endpoint(async () => {
    emptyNotificationSchema.parse(query(request));
    return data(await unreadNotificationCount(requestToken(request)));
  });
}
export function readNotificationHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    emptyNotificationSchema.parse(query(request));
    const id = z.uuid().parse((await context.params).id);
    await jsonBody(request, emptyNotificationSchema);
    return data(await markNotificationRead(requestToken(request), id));
  });
}
