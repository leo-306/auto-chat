import type { DispatchState } from "auto-chat-shared";

export function isDispatchPending(dispatch: DispatchState, lastAcknowledgedId: number): boolean {
  // Dispatch ids normally increase, but the server's SQLite data can be
  // restored independently from Chrome storage. Equality is the only safe
  // proof that this exact dispatch was already handled by this extension.
  return dispatch.id !== 0 && dispatch.id !== lastAcknowledgedId;
}

export function shouldAcknowledgeDispatch(deferredByCapacity: boolean): boolean {
  return !deferredByCapacity;
}
