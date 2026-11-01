import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

/**
 * @description The input of a bot MCP tool: an object that REFUSES a key it does not list. A plain raw shape handed to
 * the MCP SDK is wrapped in a stripping object, so a misnamed key (`filePath` for `path`) vanished before the handler
 * saw it and the tool carried on without it — an attachment never sent, the call still answered "delivered". The type
 * is the registration contract (`ToolRegistrar`): a tool whose input is not strict does not compile.
 */
export type StrictToolInput<Shape extends z.ZodRawShape = z.ZodRawShape> = z.ZodObject<Shape, z.core.$strict>;

/** A key must hold, or be held by, an allowed key at least this long to count as a near match ("id" sits in "width"). */
const minHeldKeyLength = 3;

/** An allowed key that merely holds the unknown one counts only when it is at most this much longer (`message` → `messages`, not `file` → `as_file`). */
const maxHeldLengthGap = 1;

/** A typo of up to this share of the key's length counts as a near match. */
const typoLengthDivisor = 3;

/** The keys that carry a file's path; every attachment name below stands for whichever of them an input has. */
const attachmentPathKeys: readonly string[] = ['path', 'paths'];

/** What an agent calls a file's path when it is not `path` — the commonest wrong key, and no edit distance reaches it. */
const attachmentKeyAliases: ReadonlySet<string> = new Set([
  'file', 'files', 'filename', 'filenames', 'image', 'images', 'attachment', 'attachments',
]);

/** Case and separators carry no meaning to a human mis-typing a key (`asFile`, `as_file`, `AS-FILE`). */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Edit distance where a swapped adjacent pair (`coutn`) costs one edit, the commonest typo; keys are short, so the full table is cheap. */
function getEditDistance(left: string, right: string): number {
  const table = Array.from({ length: left.length + 1 }, (_, leftIndex) => {
    const row = new Array<number>(right.length + 1).fill(0);
    row[0] = leftIndex;
    return row;
  });
  for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) table[0][rightIndex] = rightIndex;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      table[leftIndex][rightIndex] = Math.min(
        table[leftIndex - 1][rightIndex] + 1,
        table[leftIndex][rightIndex - 1] + 1,
        table[leftIndex - 1][rightIndex - 1] + substitutionCost,
      );
      const isSwappedPair =
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1];
      if (isSwappedPair) {
        table[leftIndex][rightIndex] = Math.min(table[leftIndex][rightIndex], table[leftIndex - 2][rightIndex - 2] + 1);
      }
    }
  }
  return table[left.length][right.length];
}

/** How near `allowedKey` is to `unknownKey` — lower is nearer; `null` = not a near match. Kinds do not mix: any exact beats any held beats any typo. */
function getKeyDistance(unknownKey: string, allowedKey: string): number | null {
  const unknown = normalizeKey(unknownKey);
  const allowed = normalizeKey(allowedKey);
  if (unknown.length === 0 || allowed.length === 0) return null;
  if (unknown === allowed) return 0;
  const shorterLength = Math.min(unknown.length, allowed.length);
  const isHeld = unknown.includes(allowed) || (allowed.includes(unknown) && allowed.length - unknown.length <= maxHeldLengthGap);
  if (shorterLength >= minHeldKeyLength && isHeld) {
    // Of several held keys the longest is the most specific (`filePaths` → `paths`, not `path`).
    return 1000 - shorterLength;
  }
  const typoDistance = getEditDistance(unknown, allowed);
  return typoDistance <= Math.floor(unknown.length / typoLengthDivisor) ? 2000 + typoDistance : null;
}

/**
 * @description The allowed key an unknown one was most likely meant to be — a usual name for an attachment (`file` →
 * `path`), a case/separator difference, a key that holds the other (`filePath` → `path`) or is one character longer
 * (`message` → `messages`), or a typo — or `undefined` when none is near.
 */
export function findClosestKey(unknownKey: string, allowedKeys: readonly string[]): string | undefined {
  if (attachmentKeyAliases.has(normalizeKey(unknownKey))) {
    const attachmentKey = allowedKeys.find((allowedKey) => attachmentPathKeys.includes(normalizeKey(allowedKey)));
    if (attachmentKey !== undefined) return attachmentKey;
  }
  let closestKey: string | undefined;
  let closestDistance = Infinity;
  for (const allowedKey of allowedKeys) {
    const distance = getKeyDistance(unknownKey, allowedKey);
    if (distance !== null && distance < closestDistance) {
      closestKey = allowedKey;
      closestDistance = distance;
    }
  }
  return closestKey;
}

/**
 * @description What the agent reads for an unknown key: each key named with a "did you mean" when one is near, then
 * every allowed key — the list alone lets it correct the call without another round trip.
 */
export function buildUnknownKeysMessage(unknownKeys: readonly string[], allowedKeys: readonly string[]): string {
  const sentences = unknownKeys.map((unknownKey) => {
    const closestKey = findClosestKey(unknownKey, allowedKeys);
    return closestKey === undefined
      ? `unknown key \`${unknownKey}\`.`
      : `unknown key \`${unknownKey}\` — did you mean \`${closestKey}\`?`;
  });
  return `${sentences.join(' ')} Allowed: ${allowedKeys.length > 0 ? allowedKeys.join(', ') : 'none'}.`;
}

/** The most unknown keys one diagnostic line names, and the longest a named key may be: an agent chose them, so the line stays bounded. */
const refusalLogMaxKeys = 10;
const refusalLogMaxKeyLength = 64;

/**
 * @name RefusalLogging
 * @description Where a refused call is reported, and whose call it was. The SDK checks a tool's input BEFORE any code
 * of the bot's runs, so the bot would never learn that a call was refused — a client that added a key of its own to
 * every call would fail every call with no trace on the operator's side.
 */
export interface RefusalLogging {
  toolName: string;
  /** Appends one diagnostic line; must not throw (a logger that does is ignored). */
  log: (line: string) => void;
}

/**
 * The context of the request being handled. The strict objects are module-level and shared by every request, so the
 * tool name and the logger travel with the request itself rather than with a schema.
 */
const refusalLogging = new AsyncLocalStorage<RefusalLogging>();

/** @description Run the handling of ONE tool call so that a refusal of its input is reported through `context`. */
export function runWithRefusalLogging<Result>(context: RefusalLogging, handleCall: () => Result): Result {
  return refusalLogging.run(context, handleCall);
}

/** One diagnostic line for the unknown keys of the call being handled; nothing outside {@link runWithRefusalLogging}. */
function logRefusedKeys(unknownKeys: readonly string[]): void {
  const context = refusalLogging.getStore();
  if (context === undefined) return;
  const shownKeys = unknownKeys
    .slice(0, refusalLogMaxKeys)
    .map((unknownKey) => (unknownKey.length > refusalLogMaxKeyLength ? `${unknownKey.slice(0, refusalLogMaxKeyLength)}…` : unknownKey));
  const hiddenCount = unknownKeys.length - shownKeys.length;
  const hiddenNote = hiddenCount > 0 ? ` (+${hiddenCount} more)` : '';
  try {
    context.log(`[scheduler-mcp] ${context.toolName} refused a call: unknown key(s) ${JSON.stringify(shownKeys)}${hiddenNote}`);
  } catch {
    // Reporting is best-effort: a failing logger must not turn the clear refusal below into another failure.
  }
}

/**
 * @description Close an object: a key outside `shape` is an error carrying {@link buildUnknownKeysMessage}, and a line
 * for the operator when it happens inside {@link runWithRefusalLogging}. Used for a tool's whole input and for every
 * object nested in it (an array item).
 */
export function createStrictToolInput<Shape extends z.ZodRawShape>(shape: Shape): StrictToolInput<Shape> {
  const allowedKeys = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      logRefusedKeys(issue.keys);
      return buildUnknownKeysMessage(issue.keys, allowedKeys);
    },
  });
}

/**
 * @description The `error` of a union with a strict object among its members: zod reports a failed union as a bare
 * "Invalid input" with each member's issues buried inside, so an unknown key in the object member would be lost in the
 * noise. Surfaces that member's message as the union's own; any other union failure keeps its default.
 */
export function getUnknownKeysMessageOfUnion(issue: z.core.$ZodRawIssue<z.core.$ZodIssueInvalidUnion>): string | undefined {
  return issue.errors.flat().find((memberIssue) => memberIssue.code === 'unrecognized_keys')?.message;
}
