/**
 * What the walkthrough tool passes between its parts (README: `DEVELOPMENT.md` § Walkthrough videos and screenshots): the recording a flow's run
 * leaves (`recorder.ts`), the optional config and screenshot specs a person writes, and the names of the env variables the recorder reads.
 * Everything that is read back from a file is a zod schema, so a malformed file stops with the field it got wrong.
 */
import { z } from 'zod';

/** The env variable naming the file the recorder writes the recording to. */
export const walkthroughOutEnvName = 'WALKTHROUGH_OUT';

/** The env variable naming the prefix of the flow's instance directory (`createIsolatedInstanceLayout('<prefix>', …)`), where the fake agent's logs are. */
export const walkthroughLayoutPrefixEnvName = 'WALKTHROUGH_LAYOUT_PREFIX';

const recordedButtonSchema = z.object({ text: z.string(), data: z.string().optional() });

const recordedMessageSchema = z.object({
  id: z.number(),
  /** The topic's thread id (`1` is General). */
  thread: z.number(),
  isBot: z.boolean(),
  text: z.string(),
  keyboard: z.array(z.array(recordedButtonSchema)),
});

export type RecordedButton = z.infer<typeof recordedButtonSchema>;
export type RecordedMessage = z.infer<typeof recordedMessageSchema>;

const eventBase = { atMs: z.number() };

/** What the walkthrough records, in the order it happened (`atMs` from the start of the run). */
export const walkthroughEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('step'), index: z.number(), name: z.string(), phase: z.enum(['start', 'pass', 'fail']), error: z.string().optional() }),
  z.object({ ...eventBase, kind: z.literal('chat'), messages: z.array(recordedMessageSchema) }),
  z.object({ ...eventBase, kind: z.literal('tap'), messageId: z.number(), data: z.string() }),
  z.object({ ...eventBase, kind: z.literal('prompt'), issueKey: z.string(), text: z.string() }),
  z.object({ ...eventBase, kind: z.literal('hook'), issueKey: z.string(), text: z.string() }),
  z.object({ ...eventBase, kind: z.literal('tool'), issueKey: z.string(), tool: z.string(), outcome: z.string() }),
  z.object({ ...eventBase, kind: z.literal('answer'), issueKey: z.string(), answerKind: z.string(), outcome: z.string() }),
]);

export type WalkthroughEvent = z.infer<typeof walkthroughEventSchema>;

export const walkthroughRecordingSchema = z.object({ startedAtMs: z.number(), events: z.array(walkthroughEventSchema) });

export type WalkthroughRecording = z.infer<typeof walkthroughRecordingSchema>;

/**
 * What a person may say about how a recording is shown. Everything is optional: a column per topic that spoke, named `Topic <id>` (`General`
 * for thread 1), the agent's cards labelled by the key prefix of their request (`NOTE-3` → `NOTE`).
 */
export const walkthroughConfigSchema = z.object({
  title: z.string().optional(),
  /** The operator's chat columns, left to right; without it every topic that appears gets one. */
  topics: z.array(z.object({ thread: z.number(), name: z.string() })).optional(),
  /** The label of an agent's cards, by the key prefix of its request. */
  agentLabels: z.record(z.string(), z.string()).optional(),
  /** How many of the agent's newest cards stay on screen. */
  agentKeep: z.number().int().positive().optional(),
  /** The width of the right column in pixels. */
  agentWidth: z.number().int().positive().optional(),
  /** A block that starts with this text and ends at the next blank line is shown highlighted in the agent's cards (a note the agent was handed). */
  highlightMarker: z.string().optional(),
  /** What the highlighted block is called on a card that holds none («no accounts note»); default `note`. */
  highlightName: z.string().optional(),
});

export type WalkthroughConfig = z.infer<typeof walkthroughConfigSchema>;

/** One phone-size screenshot: the first state of the chat in which a message of `thread` matches. */
export const walkthroughShotSchema = z.object({
  /** The file name, without `.png`. */
  name: z.string(),
  thread: z.number(),
  /** A regular expression the message's text must match (the whole text is one line for `.`). */
  match: z.string(),
  /** A regular expression the message's keyboard (as JSON) must match. */
  keyboardMatch: z.string().optional(),
  /** The operator's message instead of the bot's. */
  isOperatorMessage: z.boolean().optional(),
  topicName: z.string(),
  /** The grey word beside the topic's name (a language, a state). */
  subtitle: z.string().optional(),
  caption: z.string(),
  /** How many messages of the topic before the match are shown with it (default 2). */
  before: z.number().int().nonnegative().optional(),
});

export type WalkthroughShot = z.infer<typeof walkthroughShotSchema>;

export const walkthroughShotsSchema = z.array(walkthroughShotSchema);
