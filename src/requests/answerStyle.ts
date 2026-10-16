/**
 * @description The one sentence that says HOW an answer is written. Every
 * surface that tells the agent to answer through `answer_request` — the request
 * header, the reminders, the bot MCP's instructions and tool description, the
 * Jira context preamble — carries exactly this text, so the guidance cannot
 * drift between them. The readers of an answer are managers and QA, not
 * engineers. Agent-facing, so English on every surface. Kept free of imports:
 * the Jira preamble, which `bot.ts` loads statically, uses it.
 */
export const answerStyleInstruction = 'Prefer to write each answer like for a manager or QA, brief and to the point.';
