import type { ConnectorCapabilities, ConnectorOutbound } from '../../platform/outbound';

/**
 * @description Jira's outbound (Jira connector plan J2, D19). A Jira issue gets
 * the agent's ANSWERS only — they go through the Jira answer sink as comments —
 * never its streamed output, so this outbound drops stream content and activity:
 * a comment per output chunk would bury the issue. Files are refused with a
 * reason the agent can read.
 */

/** Jira rejects a comment body longer than this. */
const jiraCommentMaxChars = 32_767;

export const jiraCapabilities: ConnectorCapabilities = {
  editMessages: false,
  pinMessages: false,
  tappableOptions: false,
  attachments: false,
  threadedReplies: false,
  activityIndicator: false,
  maxMessageChars: jiraCommentMaxChars,
  markupDialect: 'markdown',
};

/** The error a file-send to a Jira issue answers with. */
export const jiraFileSendRefusal = 'Files cannot be sent to a Jira issue; describe the result in your answer instead.';

export function createJiraConnectorOutbound(): ConnectorOutbound {
  return {
    capabilities: jiraCapabilities,
    deliver: async () => {},
    deliverFile: async () => ({ ok: false, error: jiraFileSendRefusal }),
    setActivity: () => {},
    finalize: async () => {},
    dispose: () => {},
    checkIsDelivering: () => false,
    listUnfinalizedKeys: () => [],
  };
}
