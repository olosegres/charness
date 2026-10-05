import { promises as fsp } from 'fs';

/**
 * @description Stream one Jira attachment's content to a file (prompt context
 * C10). No size limit: the body is written chunk by chunk, never held whole, so
 * a file of any size works. The only rules are technical necessities:
 *
 *  - a STALL timeout — a connection that stops delivering never ends by itself
 *    and would hold the agent's tool call for ever, so no bytes for
 *    {@link jiraDownloadStallTimeoutMs} (headers included) aborts the download;
 *  - the credentials go only to the site host: `redirect=false` makes Jira answer
 *    with the content itself, but a 3xx to another host (Atlassian's media CDN,
 *    whose URL carries its own token) is followed WITHOUT the Authorization
 *    header, so the token is never handed to a host that did not ask for it;
 *  - the file is created exclusively (`wx`) at the path it is given — a caller
 *    hands it a fresh temporary name and renames it into place.
 */

export const jiraDownloadStallTimeoutMs = 2 * 60 * 1000;
/** A redirect chain longer than this is a loop, not a download. */
export const jiraDownloadMaxRedirects = 5;
const attachmentFileMode = 0o600;
const redirectStatusMin = 300;
const redirectStatusMax = 399;

export interface JiraDownloadOptions {
  /** `https://<site>`, no trailing slash. */
  baseUrl: string;
  authorization: string;
  fetchImpl: typeof fetch;
  stallTimeoutMs: number;
}

export type JiraDownloadResult =
  | { ok: true; bytes: number }
  | { ok: false; status: number; detail: string };

/**
 * @description Download attachment `attachmentId` into the new file `destinationPath`.
 * Resolves a failure instead of throwing for every outcome the caller reports
 * (a refusal, a stall, a broken connection); the file, if any was begun, is removed.
 */
export async function downloadJiraAttachment(
  options: JiraDownloadOptions,
  attachmentId: string,
  destinationPath: string,
): Promise<JiraDownloadResult> {
  const siteHost = new URL(options.baseUrl).host;
  const controller = new AbortController();
  let stallTimer: NodeJS.Timeout | null = null;
  const armStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(options.stallTimeoutMs / 1000)} s`)), options.stallTimeoutMs);
  };
  let file: fsp.FileHandle | null = null;
  try {
    armStallTimer();
    let url = `${options.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}?redirect=false`;
    for (let hop = 0; ; hop += 1) {
      const response = await options.fetchImpl(url, {
        headers: new URL(url).host === siteHost ? { Authorization: options.authorization } : {},
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (response.status >= redirectStatusMin && response.status <= redirectStatusMax && location) {
        await response.body?.cancel();
        if (hop >= jiraDownloadMaxRedirects) return { ok: false, status: 0, detail: `more than ${jiraDownloadMaxRedirects} redirects` };
        url = new URL(location, url).toString();
        armStallTimer();
        continue;
      }
      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        return { ok: false, status: response.status, detail: detail || 'no details' };
      }
      file = await fsp.open(destinationPath, 'wx', attachmentFileMode);
      const reader = response.body.getReader();
      let bytes = 0;
      for (;;) {
        armStallTimer();
        const chunk = await reader.read();
        if (chunk.done) break;
        await file.write(chunk.value);
        bytes += chunk.value.byteLength;
      }
      await file.close();
      file = null;
      return { ok: true, bytes };
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await fsp.rm(destinationPath, { force: true });
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    return { ok: false, status: 0, detail: reason instanceof Error ? reason.message : String(reason) };
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}
