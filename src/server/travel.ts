import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  TravelDraft,
  TravelDraftInput,
  ReplaceTravelDraftInput,
  travelDraftListSchema,
} from "../lib/travel";
import { requireBusinessActor } from "./business-auth";
import { transaction } from "./db";
import { ApiError } from "./errors";

type DraftRow = Omit<TravelDraft, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};
export const travelColumns = `a.id,a.app_no AS "appNo",a.title,a.applicant_id AS "applicantId",
  a.department_id AS "departmentId",a.type,a.status,a.version,
  a.created_at AS "createdAt",a.updated_at AS "updatedAt",a.submitted_at AS "submittedAt",
  t.departure,t.destination,t.start_date::text AS "startDate",t.end_date::text AS "endDate",
  t.purpose,t.companions,t.transportation,t.budget::text,t.remarks,t.duration_days AS "durationDays"`;
function serialize(row: DraftRow): TravelDraft {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function ownedTravelDraft(
  client: PoolClient,
  id: string,
  applicantId: string,
  lock = false,
) {
  const result = await client.query<DraftRow>(
    `SELECT ${travelColumns} FROM applications a JOIN travel_requests t ON t.app_id=a.id
     WHERE a.id=$1 AND a.applicant_id=$2 AND a.type='travel' ${lock ? "FOR UPDATE OF a" : ""}`,
    [id, applicantId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "NOT_FOUND", "差旅草稿不存在");
  if (row.status !== "draft")
    throw new ApiError(409, "NOT_DRAFT", "申请已不是草稿，请重新查看申请状态");
  return serialize(row);
}
function checkVersion(draft: TravelDraft, version: number) {
  if (draft.version !== version)
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "草稿已被修改，请重新加载后再操作",
    );
}
function travelValues(input: TravelDraftInput) {
  return [
    input.departure,
    input.destination,
    input.startDate,
    input.endDate,
    input.purpose,
    input.companions,
    input.transportation,
    input.budget,
    input.remarks,
  ];
}

export async function createTravelDraft(
  token: string | undefined,
  input: TravelDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const result = await client.query<{ id: string }>(
      "INSERT INTO applications(title,applicant_id,department_id) VALUES ($1,$2,$3) RETURNING id",
      [input.title, actor.id, actor.departmentId],
    );
    const id = result.rows[0].id;
    await client.query(
      `INSERT INTO travel_requests(app_id,departure,destination,start_date,end_date,purpose,companions,transportation,budget,remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, ...travelValues(input)],
    );
    return ownedTravelDraft(client, id, actor.id);
  });
}

export async function getTravelDraft(token: string | undefined, id: string) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    return ownedTravelDraft(client, id, actor.id);
  });
}

export async function listTravelDrafts(
  token: string | undefined,
  input: z.infer<typeof travelDraftListSchema>,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const { page, pageSize, keyword } = input;
    // One statement gives rows/count the same snapshot, including out-of-range pages.
    // strpos treats % and _ literally rather than as LIKE wildcards.
    const result = await client.query<{ total: number; items: TravelDraft[] }>(
      `WITH matching AS (
        SELECT ${travelColumns} FROM applications a JOIN travel_requests t ON t.app_id=a.id
        WHERE a.applicant_id=$1 AND a.type='travel' AND a.status='draft'
          AND ($2='' OR strpos(lower(a.title),lower($2))>0 OR strpos(lower(a.app_no),lower($2))>0)
      ), paged AS (SELECT * FROM matching ORDER BY "updatedAt" DESC,id LIMIT $3 OFFSET $4)
      SELECT (SELECT count(*)::int FROM matching) AS total,
        COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY "updatedAt" DESC,id) FROM paged),'[]'::jsonb) AS items`,
      [actor.id, keyword, pageSize, (page - 1) * pageSize],
    );
    return { ...result.rows[0], page, pageSize };
  });
}

export async function replaceTravelDraft(
  token: string | undefined,
  id: string,
  input: ReplaceTravelDraftInput,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const draft = await ownedTravelDraft(client, id, actor.id, true);
    checkVersion(draft, input.version);
    if (draft.version === 2147483647)
      throw new ApiError(409, "VERSION_LIMIT", "草稿已达到可编辑版本上限");
    await client.query(
      "UPDATE applications SET title=$2,department_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id, input.title, actor.departmentId],
    );
    await client.query(
      `UPDATE travel_requests SET departure=$2,destination=$3,start_date=$4,end_date=$5,
       purpose=$6,companions=$7,transportation=$8,budget=$9,remarks=$10 WHERE app_id=$1`,
      [id, ...travelValues(input)],
    );
    return ownedTravelDraft(client, id, actor.id);
  });
}

export async function deleteTravelDraft(
  token: string | undefined,
  id: string,
  version: number,
) {
  return transaction(async (client) => {
    const actor = await requireBusinessActor(token, client);
    const draft = await ownedTravelDraft(client, id, actor.id, true);
    checkVersion(draft, version);
    // Explicit deletion is restricted to owned drafts; no cascade from users/departments.
    await client.query("DELETE FROM travel_requests WHERE app_id=$1", [id]);
    await client.query("DELETE FROM applications WHERE id=$1", [id]);
    return { id, deleted: true };
  });
}
