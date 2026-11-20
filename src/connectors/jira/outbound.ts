import type { ConnectorCapabilities, ConnectorOutbound, OutboundFileRequest, OutboundFileResult } from '../../platform/outbound';
import type { SessionKey } from '../../sessionKey';

/**
 * @description Jira's outbound (Jira connector plan J2, D19). A Jira issue gets
 * the agent's ANSWERS only — they go through the Jira answer sink as comments —
 * never its streamed output, so this outbound drops stream content and activity:
 * a comment per output chunk would bury the issue. Files (`send_file_to_user`)
 * go to the connector's file sender, which attaches them to the issue and posts
 * a comment that shows them; it is set once the lazily loaded connector is
 * ready, and until then a file is refused with a reason the agent can read.
 */

/** Jira rejects a comment body longer than this. */
const jiraCommentMaxChars = 32_767;

export const jiraCapabilities: ConnectorCapabilities = {
  editMessages: false,
  pinMessages: false,
  tappableOptions: false,
  // Files are attached to the issue and shown in a comment (`outgoingFiles.ts`).
  attachments: true,
  // Comment threads: an answer goes into the thread its request came from, or of the comment it replies to (`answerSink.ts`).
  threadedReplies: true,
  activityIndicator: false,
  maxMessageChars: jiraCommentMaxChars,
  markupDialect: 'markdown',
};

/** The error a file-send to a Jira issue answers with while no connector sends files. */
export const jiraFileSendRefusal = 'Files cannot be sent to a Jira issue on this instance; describe the result in your answer instead.';

/** The connector's file send: the files attached to the issue `key` names and shown in a comment. */
export type JiraFileSender = (key: SessionKey, request: OutboundFileRequest) => Promise<OutboundFileResult>;

/** `getFileSender` is read at every send: the connector loads after this outbound is built. */
export function createJiraConnectorOutbound(getFileSender: () => JiraFileSender | null = () => null): ConnectorOutbound {
  return {
    capabilities: jiraCapabilities,
    deliver: async () => {},
    deliverFile: async (key, request) => {
      const sender = getFileSender();
      return sender ? sender(key, request) : { ok: false, error: jiraFileSendRefusal };
    },
    setActivity: () => {},
    finalize: async () => {},
    dispose: () => {},
    checkIsDelivering: () => false,
    listUnfinalizedKeys: () => [],
  };
}
