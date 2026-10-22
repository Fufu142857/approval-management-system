import { z } from "zod";
import { ApiError } from "./errors";
import { draftVersionSchema } from "../lib/travel";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";
import {
  getReimbursementApplication,
  submitReimbursementDraft,
} from "./reimbursement-submission";

function noQuery(request: Request) {
  if ([...new URL(request.url).searchParams].length)
    throw new ApiError(400, "VALIDATION_ERROR", "此接口不接受查询参数");
}
type Context = { params: Promise<{ id: string }> };
export function submitReimbursementHandler(request: Request, context: Context) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const { version } = await jsonBody(request, draftVersionSchema);
    return data(
      await submitReimbursementDraft(requestToken(request), id, version),
    );
  });
}
export function reimbursementApplicationHandler(
  request: Request,
  context: Context,
) {
  return endpoint(async () => {
    noQuery(request);
    return data(
      await getReimbursementApplication(
        requestToken(request),
        z.uuid().parse((await context.params).id),
      ),
    );
  });
}
