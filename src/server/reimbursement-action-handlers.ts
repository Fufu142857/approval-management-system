import { z } from "zod";
import { ApiError } from "./errors";
import {
  reimbursementDecisionSchema,
  reimbursementWithdrawalSchema,
} from "../lib/reimbursement-actions";
import {
  decideReimbursementTask,
  withdrawReimbursementApplication,
} from "./reimbursement-actions";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";

function noQuery(request: Request) {
  if ([...new URL(request.url).searchParams].length)
    throw new ApiError(400, "VALIDATION_ERROR", "此接口不接受查询参数");
}

export function reimbursementDecisionHandler(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const taskId = z.uuid().parse(params.taskId);
    const input = await jsonBody(request, reimbursementDecisionSchema);
    return data(
      await decideReimbursementTask(requestToken(request), id, taskId, input),
    );
  });
}
export function reimbursementWithdrawalHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, reimbursementWithdrawalSchema);
    return data(
      await withdrawReimbursementApplication(requestToken(request), id, input),
    );
  });
}
