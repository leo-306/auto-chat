import type { DispatchState } from "auto-chat-shared";

export type DispatchAcknowledgement = Pick<DispatchState, "id" | "token">;
export type TargetedDispatchAction = "claim" | "recheck" | "acknowledge_active_worker";

export function isDispatchPending(dispatch: DispatchState, lastAcknowledged: DispatchAcknowledgement): boolean {
  if (dispatch.id === 0) return false;
  // Dispatch ids can be reused if the service data is restored independently
  // from Chrome storage. Newer servers attach a fresh token to every signal;
  // only that token proves the exact signal was already acknowledged.
  if (dispatch.token) return dispatch.token !== lastAcknowledged.token;
  return dispatch.id !== lastAcknowledged.id;
}

export function shouldAcknowledgeDispatch(deferredByCapacity: boolean): boolean {
  return !deferredByCapacity;
}

// A repeated targeted signal may arrive while the original scheduler tick is
// still submitting the prompt. That worker owns the job, so reloading its tab
// for a manual recheck would interrupt the in-flight submission.
export function targetedDispatchAction(
  isRecheckable: boolean,
  hasActiveWorker: boolean
): TargetedDispatchAction {
  if (!isRecheckable) return "claim";
  return hasActiveWorker ? "acknowledge_active_worker" : "recheck";
}
