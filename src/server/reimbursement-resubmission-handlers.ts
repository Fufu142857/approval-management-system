import { z } from "zod";
import { draftVersionSchema } from "../lib/travel";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  copyReimbursementForResubmission,
  getReimbursementResubmission,
} from "./reimbursement-resubmission";
import { ApiError } from "./errors";
type Context = { params: Promise<{ id: string }> };
function noQuery(request: Request) {
  if (new URL(request.url).searchParams.size)
    throw new ApiError(400, "VALIDATION_ERROR", "此接口不接受查询参数");
}
export function reimbursementResubmissionHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    return data(await getReimbursementResubmission(requestToken(request), id));
  });
}
export function copyReimbursementHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    const result = await copyReimbursementForResubmission(
      requestToken(request),
      id,
      version,
    );
    return data(result, result.created ? 201 : 200);
  });
}
