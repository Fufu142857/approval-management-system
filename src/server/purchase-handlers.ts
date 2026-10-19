import { z } from "zod";
import { draftVersionSchema } from "../lib/travel";
import {
  purchaseDraftSchema,
  replacePurchaseDraftSchema,
  purchaseDraftListSchema,
} from "../lib/purchase";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import { ApiError } from "./errors";
import {
  createPurchaseDraft,
  listPurchaseDrafts,
  getPurchaseDraft,
  replacePurchaseDraft,
  deletePurchaseDraft,
} from "./purchase";
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
export function createPurchaseDraftHandler(request: Request) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    return data(
      await createPurchaseDraft(
        requestToken(request),
        await jsonBody(request, purchaseDraftSchema, 262144),
      ),
      201,
    );
  });
}
export function listPurchaseDraftsHandler(request: Request) {
  return endpoint(async () =>
    data(
      await listPurchaseDrafts(
        requestToken(request),
        purchaseDraftListSchema.parse(query(request)),
      ),
    ),
  );
}
export function getPurchaseDraftHandler(request: Request, context: Context) {
  return endpoint(async () => {
    noQuery(request);
    return data(
      await getPurchaseDraft(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
export function replacePurchaseDraftHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    return data(
      await replacePurchaseDraft(
        requestToken(request),
        id,
        await jsonBody(request, replacePurchaseDraftSchema, 262144),
      ),
    );
  });
}
export function deletePurchaseDraftHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(await deletePurchaseDraft(requestToken(request), id, version));
  });
}
