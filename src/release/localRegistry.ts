import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';

/**
 * @description A loopback npm registry for the release's install check: it serves ONE package version from a tarball on disk — its
 * packument marks the shrinkwrap the tarball carries (`_hasShrinkwrap`), which the npm registry does for a published package and
 * npm then installs by — and passes every other request (the dependencies) on to the real registry. So `npm install -g <name>@<version>`
 * against it is the install a user makes after the release, before anything is published. Loopback only; nothing is uploaded.
 */

const upstreamRegistryUrl = 'https://registry.npmjs.org';
const upstreamTimeoutMs = 60_000;
const notFoundStatus = 404;
const badGatewayStatus = 502;

/** A `package.json` as read from the tarball: the name and version the registry serves it under, every other field passed through. */
export interface LocalRegistryManifest {
  name: string;
  version: string;
  [field: string]: object | string | number | boolean | null | undefined;
}

/** The package version the registry serves: its manifest (`package.json`), the tarball and whether it holds an `npm-shrinkwrap.json`. */
export interface LocalRegistryPackage {
  manifest: LocalRegistryManifest;
  tarballPath: string;
  hasShrinkwrap: boolean;
}

export interface LocalRegistry {
  /** The registry's URL, with a trailing slash, for `--registry`. */
  url: string;
  stop(): Promise<void>;
}

/** @description Start the registry for `served` on a free loopback port. */
export async function startLocalRegistry(served: LocalRegistryPackage): Promise<LocalRegistry> {
  const bytes = fs.readFileSync(served.tarballPath);
  const { name, version } = served.manifest;
  const tarballFileName = `${name.split('/').at(-1)}-${version}.tgz`;
  const packumentPath = `/${name.replace('/', '%2f')}`;
  let baseUrl = '';
  const buildPackument = (): string => JSON.stringify({
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...served.manifest,
        _hasShrinkwrap: served.hasShrinkwrap,
        dist: {
          tarball: `${baseUrl}${name}/-/${tarballFileName}`,
          integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
          shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
        },
      },
    },
  });
  const server = http.createServer((request, response) => {
    const requestPath = (request.url ?? '/').split('?')[0];
    if (requestPath.toLowerCase() === packumentPath || requestPath === `/${name}`) {
      response.setHeader('content-type', 'application/json');
      response.end(buildPackument());
      return;
    }
    if (requestPath === `/${name}/-/${tarballFileName}`) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(bytes);
      return;
    }
    if (requestPath.startsWith(`/${name}/-/`)) {
      response.statusCode = notFoundStatus;
      response.end('not served here');
      return;
    }
    // Every other request is a dependency: the real registry answers it.
    fetch(`${upstreamRegistryUrl}${request.url ?? '/'}`, { headers: { accept: request.headers.accept ?? '*/*' }, signal: AbortSignal.timeout(upstreamTimeoutMs) })
      .then(async (upstream) => {
        response.statusCode = upstream.status;
        const contentType = upstream.headers.get('content-type');
        if (contentType) response.setHeader('content-type', contentType);
        response.end(Buffer.from(await upstream.arrayBuffer()));
      })
      .catch((error: Error) => {
        response.statusCode = badGatewayStatus;
        response.end(`the upstream registry did not answer: ${error.message}`);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the local registry did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}/`;
  return {
    url: baseUrl,
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
