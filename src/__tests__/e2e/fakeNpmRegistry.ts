/**
 * @description A loopback npm registry for the update flows: it serves the packument and the tarballs of the package under
 * test (`charness`, versions the test publishes, a `latest` the test moves, a deprecation the test sets) and PROXIES everything else —
 * the dependencies a real `npm install -g` resolves — to the real registry, so an install is the real thing end to end. The test points
 * npm at it with `NPM_CONFIG_REGISTRY`; nothing the test publishes ever leaves the machine.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';

const packageName = 'charness';
const upstreamRegistry = 'https://registry.npmjs.org';
const upstreamTimeoutMs = 60 * 1000;

/** A package.json: the fields the flows touch, and whatever else the repository's own carries. */
export interface PackageManifest {
  version: string;
  engines: { node: string };
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [field: string]: object | string | undefined;
}

export interface PublishedVersion {
  version: string;
  /** The package's own `package.json` content for this version (its `dependencies` are what npm resolves next). */
  manifest: PackageManifest;
  tarballPath: string;
  engines?: { node: string };
  deprecated?: string;
}

interface StoredVersion extends PublishedVersion {
  integrity: string;
  shasum: string;
  bytes: Buffer;
}

export class FakeNpmRegistry {
  private server: http.Server | null = null;
  private readonly versions = new Map<string, StoredVersion>();
  private latest: string | null = null;
  /** Every request path the registry answered itself, for assertions ("npm asked the registry for the packument"). */
  readonly requests: string[] = [];
  baseUrl = '';

  /** @description Start on a free loopback port; resolves the registry's base URL (with a trailing slash). */
  async start(): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error: Error) => {
        response.statusCode = 502;
        response.end(`fake registry error: ${error.message}`);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the fake registry did not bind a TCP port');
    this.baseUrl = `http://127.0.0.1:${address.port}/`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** @description Make a version installable; the first one published is `latest` until the test moves it. */
  publish(published: PublishedVersion): void {
    const bytes = fs.readFileSync(published.tarballPath);
    this.versions.set(published.version, {
      ...published,
      bytes,
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
    });
    this.latest ??= published.version;
  }

  setLatest(version: string): void {
    if (!this.versions.has(version)) throw new Error(`${version} is not published`);
    this.latest = version;
  }

  deprecate(version: string, message: string | undefined): void {
    const stored = this.versions.get(version);
    if (!stored) throw new Error(`${version} is not published`);
    stored.deprecated = message;
  }

  private buildPackument(): object {
    const versions: Record<string, object> = {};
    for (const stored of this.versions.values()) {
      versions[stored.version] = {
        ...stored.manifest,
        name: packageName,
        version: stored.version,
        ...(stored.engines ? { engines: stored.engines } : {}),
        ...(stored.deprecated ? { deprecated: stored.deprecated } : {}),
        dist: {
          tarball: `${this.baseUrl}${packageName}/-/${packageName}-${stored.version}.tgz`,
          integrity: stored.integrity,
          shasum: stored.shasum,
        },
      };
    }
    return { name: packageName, 'dist-tags': { latest: this.latest }, versions };
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    if (urlPath === `/${packageName}`) {
      this.requests.push(urlPath);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(this.buildPackument()));
      return;
    }
    const tarballMatch = new RegExp(`^/${packageName}/-/${packageName}-(.+)\\.tgz$`).exec(urlPath);
    if (tarballMatch) {
      this.requests.push(urlPath);
      const stored = this.versions.get(tarballMatch[1]);
      if (!stored) {
        response.statusCode = 404;
        response.end('no such version');
        return;
      }
      response.setHeader('content-type', 'application/octet-stream');
      response.end(stored.bytes);
      return;
    }
    // Everything else is a dependency: the real registry answers it.
    const upstream = await fetch(`${upstreamRegistry}${request.url ?? '/'}`, {
      headers: { accept: request.headers.accept ?? '*/*' },
      signal: AbortSignal.timeout(upstreamTimeoutMs),
    });
    response.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }
}
