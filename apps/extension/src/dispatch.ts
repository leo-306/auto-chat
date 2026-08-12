import type { DispatchState } from "auto-chat-shared";

export type DispatchAcknowledgement = Pick<DispatchState, "id" | "token">;

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
