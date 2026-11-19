/**
 * @description Notes the moment the bot's FIRST long poll has been answered — the updates that waited while the bot was down are then
 * in its hands (the dispatcher queues them, `updateDispatcher.size()` says when they are handled). The boot wave of the topic status
 * marks waits for it: an owner's rename made during the downtime must be learned before the wave writes. «No update is in flight» alone
 * says nothing before the first poll returned, and none between two batches.
 */
import type { CallApiHost } from '../../outputTrace';

/** @name FirstUpdateBatchNote @description What {@link installFirstUpdateBatchNote} gives back. */
export interface FirstUpdateBatchNote {
  /** Whether a `getUpdates` call has been answered (a batch, however empty, was fetched). */
  checkIsFirstBatchFetched: () => boolean;
}

/** @description Wrap `host.callApi` so the first answered `getUpdates` is noted; every call and every answer goes through untouched. */
export function installFirstUpdateBatchNote(host: CallApiHost): FirstUpdateBatchNote {
  let isFirstBatchFetched = false;
  const originalCallApi = host.callApi.bind(host);
  host.callApi = async (method, payload, options) => {
    const answer = await originalCallApi(method, payload, options);
    if (method === 'getUpdates') isFirstBatchFetched = true;
    return answer;
  };
  return { checkIsFirstBatchFetched: () => isFirstBatchFetched };
}
