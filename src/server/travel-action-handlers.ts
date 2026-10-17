import { z } from "zod";
import {
  travelDecisionSchema,
  travelWithdrawalSchema,
} from "../lib/travel-actions";
import { decideTravelTask, withdrawTravelApplication } from "./travel-actions";
import { checkOrigin, data, endpoint, jsonBody, requestToken } from "./http";

export function travelDecisionHandler(
  request: Request,
  context: { params: Promise<{ id: string; taskId: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const taskId = z.uuid().parse(params.taskId);
    const input = await jsonBody(request, travelDecisionSchema);
    return data(
      await decideTravelTask(requestToken(request), id, taskId, input),
    );
  });
}
export function travelWithdrawalHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return endpoint(async () => {
    checkOrigin(request);
    const id = z.uuid().parse((await context.params).id);
    const input = await jsonBody(request, travelWithdrawalSchema);
    return data(
      await withdrawTravelApplication(requestToken(request), id, input),
    );
  });
}
