import { z } from "zod";
import { ApiError } from "./errors";
import {
  purchaseDecisionSchema,
  purchaseWithdrawalSchema,
} from "../lib/purchase-actions";
import {
  decidePurchaseTask,
  withdrawPurchaseApplication,
} from "./purchase-actions";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";

function noQuery(request: Request) {
  if ([...new URL(request.url).searchParams].length)
    throw new ApiError(400, "VALIDATION_ERROR", "此接口不接受查询参数");
}

export function purchaseDecisionHandler(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const taskId = z.uuid().parse(params.taskId);
    const input = await jsonBody(request, purchaseDecisionSchema);
    return data(
      await decidePurchaseTask(requestToken(request), id, taskId, input),
    );
  });
}
export function purchaseWithdrawalHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    noQuery(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, purchaseWithdrawalSchema);
    return data(
      await withdrawPurchaseApplication(requestToken(request), id, input),
    );
  });
}
