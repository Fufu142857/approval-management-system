import type { TravelApplication, TravelDraft } from "./travel";
export type TravelSuccessor = {
  id: string;
  appNo: string;
  status: TravelDraft["status"] | TravelApplication["status"];
  version: number;
};
export type TravelResubmission = {
  sourceId: string;
  successor: TravelSuccessor | null;
};
export type TravelResubmissionResult = {
  sourceId: string;
  successor: TravelSuccessor;
  created: boolean;
};
