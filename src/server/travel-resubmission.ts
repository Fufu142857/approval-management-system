import type { PoolClient } from "pg";
import type {
  TravelResubmission,
  TravelResubmissionResult,
  TravelSuccessor,
} from "../lib/travel-resubmission";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

async function source(
  client: PoolClient,
  id: string,
  ownerId: string,
  write: boolean,
) {
  const result = await client.query<{
    id: string;
    title: string;
    version: number;
    status: string;
  }>(
    `SELECT id,title,version,status FROM applications WHERE id=$1 AND applicant_id=$2 AND type='travel' FOR ${write ? "UPDATE" : "SHARE"}`,
    [id, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "原申请不存在或无权访问");
  if (!["rejected", "withdrawn"].includes(row.status))
    throw new ApiError(
      409,
      "NOT_RESUBMITTABLE",
      "仅本人已驳回或已撤回的差旅申请可以复制重提",
    );
  return row;
}
async function successor(client: PoolClient, id: string, ownerId: string) {
  return (
    (
      await client.query<TravelSuccessor>(
        `SELECT id,app_no AS "appNo",status,version FROM applications
      WHERE resubmission_of=$1 AND applicant_id=$2 AND type='travel' FOR SHARE`,
        [id, ownerId],
      )
    ).rows[0] ?? null
  );
}
export async function getTravelResubmission(
  token: string | undefined,
  id: string,
): Promise<TravelResubmission> {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    await source(client, id, actor.id, false);
    return { sourceId: id, successor: await successor(client, id, actor.id) };
  });
}
export async function copyTravelForResubmission(
  token: string | undefined,
  id: string,
  version: number,
): Promise<TravelResubmissionResult> {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    // Serialize copies on the source, without changing its version, timestamps or history.
    const original = await source(client, id, actor.id, true);
    if (original.version !== version)
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "原申请版本已变化，请重新读取后操作",
      );
    const existing = await successor(client, id, actor.id);
    if (existing) return { sourceId: id, successor: existing, created: false };
    const copied = (
      await client.query<TravelSuccessor>(
        `INSERT INTO applications(title,applicant_id,department_id,resubmission_of)
        VALUES ($1,$2,$3,$4) RETURNING id,app_no AS "appNo",status,version`,
        [original.title, actor.id, actor.departmentId, id],
      )
    ).rows[0];
    const detail = await client.query(
      `INSERT INTO travel_requests(app_id,departure,destination,start_date,end_date,purpose,companions,transportation,budget,remarks)
       SELECT $1,departure,destination,start_date,end_date,purpose,companions,transportation,budget,remarks FROM travel_requests WHERE app_id=$2`,
      [copied.id, id],
    );
    if (detail.rowCount !== 1)
      throw new ApiError(
        409,
        "SOURCE_INCOMPLETE",
        "原申请明细不完整，请核对后再复制",
      );
    // Attachments and execution records stay on the source. New submission revalidates everything.
    return { sourceId: id, successor: copied, created: true };
  });
}
