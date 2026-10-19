import { z } from "zod";
import { ApiError } from "./errors";
import { draftVersionSchema } from "../lib/travel";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  getPurchaseApplication,
  submitPurchaseDraft,
} from "./purchase-submission";

function noQuery(request: Request) {
  if ([...new URL(request.url).searchParams].length)
    throw new ApiError(400, "VALIDATION_ERROR", "此接口不接受查询参数");
}
type Context = { params: Promise<{ id: string }> };
export function submitPurchaseHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(await submitPurchaseDraft(requestToken(request), id, version));
  });
}
export function purchaseApplicationHandler(request: Request, context: Context) {
  return endpoint(async () => {
    noQuery(request);
    return data(
      await getPurchaseApplication(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
