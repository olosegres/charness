import type { SessionKey } from '../sessionKey';
import type { PostToSessionOptions, PostToSessionResult, SessionPromptText } from '../postToSession';
import type { RequestWakeUpEngine } from './wakeUpEngine';

/**
 * @description What a tracker conversation's request prompt and issue update do once handed to the session post: the post itself,
 * then the wake-up engine's part — watch the turn the prompt started, hand a failed post to the retries (R28), or, for a requester's
 * comment HELD over a usage-limit wait, record that the request owes an answer from now on (`notePersonInputHeld`: no turn starts
 * for it until the wait ends, and the turn that carries it then must be read against what the request owes). The turn is watched
 * INSIDE the post, right after the write (`afterForward`): a reminder the post delivers after it then joins a turn this request
 * started, so a job the agent arms in it is armed under this request (`requests/README.md` § Turn starts). A module of its own,
 * over ports, so every branch is tested for real; `bot.ts` wires the shared session post and the engine.
 */

/** The wake-up engine's part in posting a tracker turn. */
export type TrackerTurnEngine = Pick<RequestWakeUpEngine, 'trackForwardedTurn' | 'notePostFailed' | 'notePersonInputHeld'>;

export interface TrackerTurnPosterPorts {
  /** The shared session post (`postToSession`) of this conversation's adapter; `afterForward` watches the turn the write started. */
  post: (key: SessionKey, prompt: SessionPromptText, options: Pick<PostToSessionOptions, 'afterForward'>) => Promise<PostToSessionResult>;
  /** A person's message clears the spent idle-compaction latch like a topic's message does (and lifts the todo reminder's silence). */
  notePersonActivity: (key: SessionKey) => void;
  /** The wake-up engine, read at call time: it is built after the connector's deps. */
  getEngine: () => TrackerTurnEngine | null;
}

export interface TrackerTurnPoster {
  /** Post a request's prompt; a failure is handed to the engine's post retries and thrown back to the connector. */
  postRequest: (key: SessionKey, requestId: string, prompt: SessionPromptText) => Promise<void>;
  /** Post an issue update for the request `getTargetRequestId` names (read once the update is written); opens no request. */
  postUpdate: (key: SessionKey, prompt: SessionPromptText, getTargetRequestId: () => string) => Promise<void>;
}

function getPostFailureMessage(posted: Extract<PostToSessionResult, { ok: false }>): string {
  return posted.reason === 'forward-failed' ? posted.error : `session ${posted.reason}`;
}

export function createTrackerTurnPoster(ports: TrackerTurnPosterPorts): TrackerTurnPoster {
  return {
    postRequest: async (key, requestId, prompt) => {
      ports.notePersonActivity(key);
      // A held request is tracked when the wait's resume, or else its next wake-up, posts its prompt (R21): it has no answer yet,
      // so it owes one the whole time.
      const posted = await ports.post(key, prompt, {
        afterForward: async () => { await ports.getEngine()?.trackForwardedTurn(key, requestId, { isRequestPrompt: true }); },
      });
      if (!posted.ok) {
        // R28: retried at about 1, 5 and 15 min, outside the wake-up cap.
        await ports.getEngine()?.notePostFailed(key, requestId);
        throw new Error(getPostFailureMessage(posted));
      }
    },
    postUpdate: async (key, prompt, getTargetRequestId) => {
      ports.notePersonActivity(key);
      // A requester's comment carries a person's words: forwarded, the turn it starts owes them an answer; held, they are owed already.
      const posted = await ports.post(key, prompt, {
        afterForward: async () => { await ports.getEngine()?.trackForwardedTurn(key, getTargetRequestId(), { isRequestPrompt: false, isPersonInput: true }); },
      });
      // A failure goes back to the connector, which decides the comment again.
      if (!posted.ok) throw new Error(getPostFailureMessage(posted));
      if (posted.isHeld) await ports.getEngine()?.notePersonInputHeld(key, getTargetRequestId());
    },
  };
}
