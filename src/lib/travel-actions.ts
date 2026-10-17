import { z } from "zod";
import { draftVersionSchema } from "./travel";

const opinion = z.string().trim().max(2000).default("");
export const travelDecisionSchema = draftVersionSchema
  .extend({
    decision: z.enum(["approve", "reject"]),
    opinion,
  })
  .refine((input) => input.decision !== "reject" || input.opinion.length > 0, {
    message: "驳回必须填写理由",
    path: ["opinion"],
  });
export const travelWithdrawalSchema = draftVersionSchema.extend({ opinion });
export type TravelDecisionInput = z.infer<typeof travelDecisionSchema>;
export type TravelWithdrawalInput = z.infer<typeof travelWithdrawalSchema>;
