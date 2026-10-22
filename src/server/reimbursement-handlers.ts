import { z } from "zod";
import { draftVersionSchema } from "../lib/travel";
import {
  reimbursementDraftSchema,
  replaceReimbursementDraftSchema,
  reimbursementDraftListSchema,
  reimbursementLinkOptionsSchema,
} from "../lib/reimbursement";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import { ApiError } from "./errors";
import {
  createReimbursementDraft,
  listReimbursementDrafts,
  getReimbursementDraft,
  replaceReimbursementDraft,
  deleteReimbursementDraft,
  listReimbursementLinkOptions,
} from "./reimbursement";
type Context = { params: Promise<{ id: string }> };
function query(request: Request) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(result, key))
      throw new ApiError(400, "VALIDATION_ERROR", "查询参数不能重复");
    result[key] = value;
  }
  return result;
}
function noQuery(request: Request) {
  z.strictObject({}).parse(query(request));
}
export function createReimbursementDraftHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    return data(
      await createReimbursementDraft(
        requestToken(request),
        await jsonBody(request, reimbursementDraftSchema, 262144),
      ),
      201,
    );
  });
}
export function listReimbursementDraftsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listReimbursementDrafts(
        requestToken(request),
        reimbursementDraftListSchema.parse(query(request)),
      ),
    ),
  );
}
export function getReimbursementDraftHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    noQuery(request);
    return data(
      await getReimbursementDraft(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function replaceReimbursementDraftHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    return data(
      await replaceReimbursementDraft(
        requestToken(request),
        id,
        await jsonBody(request, replaceReimbursementDraftSchema, 262144),
      ),
    );
  });
}
export function deleteReimbursementDraftHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(
      await deleteReimbursementDraft(requestToken(request), id, version),
    );
  });
}

export function reimbursementLinkOptionsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listReimbursementLinkOptions(
        requestToken(request),
        reimbursementLinkOptionsSchema.parse(query(request)),
      ),
    ),
  );
}
