import { z } from 'zod';

/**
 * @description What `meta.json` of a job holds: written by the main box at submit, kept on the runner next to the job, read back by `ls`
 * and `status` and — for the project root — by a later `wait` / `fetch` (which only trust the root when it matches the job's slug).
 */

const jobMetaSchema = z.looseObject({
  id: z.string(),
  runner: z.string(),
  slug: z.string(),
  projectRoot: z.string(),
  subfolder: z.string(),
  command: z.string(),
  submittedAtMs: z.number(),
  timeoutSeconds: z.number(),
  owner: z.string(),
  group: z.string(),
  isBackground: z.boolean(),
});

export interface JobMeta {
  id: string;
  runner: string;
  slug: string;
  /** The project's root on the main box. */
  projectRoot: string;
  subfolder: string;
  command: string;
  submittedAtMs: number;
  timeoutSeconds: number;
  /** `<hostname>:<uid>` of the user who submitted: `ls --all` lists the jobs of THIS user only. */
  owner: string;
  group: string;
  isBackground: boolean;
}

/** @description Parse a job's `meta.json`; `null` when it is not one. */
export function parseJobMeta(text: string): JobMeta | null {
  try {
    const parsed = jobMetaSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
