import type {
  NotificationItem,
  NotificationListInput,
} from "../lib/notifications";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

// Notification ownership grants access to the event, never automatically to its application.
// Each read obtains event and current target/task state from one SQL snapshot.
const projection = `SELECT n.id,n.app_id AS "appId",n.kind,n.title,n.created_at AS "createdAt",n.read_at AS "readAt",
  CASE WHEN access.allowed THEN jsonb_build_object('type',a.type,'id',a.id,'status',a.status,
    'apiPath','/api/'||a.type||'-applications/'||a.id::text) ELSE NULL END AS target,
  CASE WHEN access.allowed AND t.id IS NOT NULL THEN jsonb_build_object('id',t.id,'status',t.status) ELSE NULL END AS task`;
const targetJoins = `JOIN applications a ON a.id=n.app_id
  LEFT JOIN approval_instances i ON i.app_id=a.id
  LEFT JOIN approval_tasks t ON t.instance_id=i.id AND t.approver_id=$1
    AND n.kind='approval.pending' AND n.event_key='task:'||t.id::text||':pending'
  CROSS JOIN LATERAL (SELECT a.type IN ('travel','purchase') AND a.status<>'draft' AND
    (a.applicant_id=$1 OR EXISTS (SELECT 1 FROM approval_tasks owned
      WHERE owned.instance_id=i.id AND owned.approver_id=$1 AND owned.activated_at IS NOT NULL)) AS allowed) access`;

export async function listNotifications(
  token: string | undefined,
  input: NotificationListInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const { page, pageSize, state } = input;
    const result = await client.query<{
      items: NotificationItem[];
      total: number;
      unreadCount: number;
    }>(
      `WITH owned AS (SELECT * FROM notifications WHERE recipient_id=$1),
       matching AS (SELECT * FROM owned WHERE $2='all' OR ($2='unread' AND read_at IS NULL) OR ($2='read' AND read_at IS NOT NULL)),
       paged AS (SELECT * FROM matching ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4),
       enriched AS (${projection} FROM paged n ${targetJoins})
       SELECT (SELECT count(*)::int FROM matching) AS total,
        (SELECT count(*)::int FROM owned WHERE read_at IS NULL) AS "unreadCount",
        COALESCE((SELECT jsonb_agg(enriched ORDER BY "createdAt" DESC,id DESC) FROM enriched),'[]'::jsonb) AS items`,
      [actor.id, state, pageSize, (page - 1) * pageSize],
    );
    return { ...result.rows[0], page, pageSize };
  });
}

export async function getNotification(token: string | undefined, id: string) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const result = await client.query<
      Omit<NotificationItem, "createdAt" | "readAt"> & {
        createdAt: Date;
        readAt: Date | null;
      }
    >(
      `${projection} FROM notifications n ${targetJoins} WHERE n.id=$2 AND n.recipient_id=$1`,
      [actor.id, id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "NOT_FOUND", "通知不存在或无权访问");
    const row = result.rows[0];
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    };
  });
}

export async function unreadNotificationCount(token: string | undefined) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    return (
      await client.query<{ unreadCount: number }>(
        'SELECT count(*)::int AS "unreadCount" FROM notifications WHERE recipient_id=$1 AND read_at IS NULL',
        [actor.id],
      )
    ).rows[0];
  });
}

export async function markNotificationRead(
  token: string | undefined,
  id: string,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    // UPDATE locks the owned row; concurrent retries preserve the first read time.
    const result = await client.query<{ id: string; readAt: Date }>(
      `UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp())
       WHERE id=$1 AND recipient_id=$2 RETURNING id,read_at AS "readAt"`,
      [id, actor.id],
    );
    if (!result.rowCount)
      throw new ApiError(404, "NOT_FOUND", "通知不存在或无权访问");
    return {
      id: result.rows[0].id,
      readAt: result.rows[0].readAt.toISOString(),
    };
  });
}
