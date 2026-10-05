import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { adfNodeSchema } from '../connectors/jira/adf';
import type { JiraAttachment, JiraComment, JiraIssue } from '../connectors/jira/client';

/**
 * @description The sanitised ADF, rendered HTML and attachment list recorded
 * from a real sandbox site (Jira prompt context S1): `fixtures/jiraMediaAdf.json`.
 * Validated by a schema on load, so a malformed edit of the fixture fails loudly.
 * Not a test file (no `.test.ts`): shared by the media and block tests.
 */

const accountSchema = z.object({ accountId: z.string(), accountType: z.string(), displayName: z.string() });

const fixtureSchema = z.object({
  issueKey: z.string(),
  description: z.object({ body: adfNodeSchema, renderedBody: z.string() }),
  attachments: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    created: z.string(),
    author: accountSchema,
  })),
  comments: z.array(z.object({
    id: z.string(),
    author: accountSchema,
    created: z.string(),
    updated: z.string(),
    updateAuthor: accountSchema,
    jsdPublic: z.boolean(),
    body: adfNodeSchema,
    renderedBody: z.string(),
  })),
  restrictedCommentSchemaExample: z.object({
    id: z.string(),
    author: accountSchema,
    created: z.string(),
    updated: z.string(),
    updateAuthor: accountSchema,
    jsdPublic: z.boolean(),
    visibility: z.object({ type: z.string(), value: z.string(), identifier: z.string() }),
    body: adfNodeSchema,
  }),
});

export type JiraMediaFixture = z.infer<typeof fixtureSchema>;

export function loadJiraMediaFixture(): JiraMediaFixture {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'jiraMediaAdf.json'), 'utf8');
  return fixtureSchema.parse(JSON.parse(text));
}

/** The fixture as the client would hand it over: the issue (description, attachments), its comments, no links. */
export function createFixtureContext(fixture: JiraMediaFixture): { issue: JiraIssue; comments: JiraComment[] } {
  const attachments: JiraAttachment[] = fixture.attachments;
  return {
    issue: {
      id: '10100',
      key: fixture.issueKey,
      fields: {
        summary: 'Media probe',
        status: { id: '1', name: 'To Do' },
        description: fixture.description.body,
        attachment: attachments,
      },
      renderedFields: { description: fixture.description.renderedBody },
    },
    comments: fixture.comments,
  };
}
