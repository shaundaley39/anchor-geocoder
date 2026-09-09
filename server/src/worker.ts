/**
 * One request thread.
 *
 * A full Fastify instance over typed-array views of the index the pool loaded,
 * which is the entire trick: the artifact is shared memory, so a thread costs
 * its own event loop and its own caches rather than its own 4.4 GB.
 *
 * The thread is CPU-bound by design. Every geocode is synchronous array work
 * with no I/O in it, so a request occupies a thread for its whole duration and
 * throughput is threads x (1 / service time), which is exactly the thing a
 * single Node process could not do.
 */
import { createServer, type Server } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { artifactFromBundle, type ArtifactBundle } from './artifact.js';
import { buildReverseIndex, type BBox } from './reverse.js';
import { buildServer } from './server.js';

/** How a worker is told to listen. */
export type ListenPlan =
  /** Bind a socket of its own; `reusePort` lets the kernel share the port. */
  | { kind: 'bind'; port: number; host: string; reusePort: boolean }
  /** Accept on the descriptor the first worker already bound. */
  | { kind: 'adopt'; fd: number };

export interface WorkerInit {
  bundle: ArtifactBundle;
  bbox: BBox;
  listen: ListenPlan;
}

export type WorkerMessage =
  /**
   * Listening. `fd` and `port` are set only by a worker that bound the socket
   * itself; the port is what the pool needs when it was asked for port 0 and
   * the remaining workers have to be told which ephemeral port to join.
   */
  | { type: 'listening'; fd: number | null; port: number | null }
  | { type: 'failed'; message: string };

/**
 * The descriptor of a listening server, which Node exposes nowhere public.
 *
 * Needed only on the platforms that refuse SO_REUSEPORT, where the one way to
 * put several threads behind one port is to have them accept on the same
 * socket. Threads share a descriptor table, so the number is all that travels.
 */
function listeningFd(server: Server): number | null {
  const handle = (server as unknown as { _handle?: { fd?: number } })._handle;
  return typeof handle?.fd === 'number' && handle.fd >= 0 ? handle.fd : null;
}

async function main(): Promise<void> {
  const port = parentPort;
  if (port === null) throw new Error('worker.ts must be run as a worker thread');
  const init = workerData as WorkerInit;

  const artifact = artifactFromBundle(init.bundle);
  const reverseIndex = buildReverseIndex(artifact, init.bbox);

  let server!: Server;
  const app = await buildServer({
    artifact,
    reverseIndex,
    options: {
      serverFactory: (handler) => {
        server = createServer(handler);
        return server;
      },
    },
  });
  // Built by the factory above, so the routes are wired but nothing is bound
  // until `ready` resolves and the plan below is applied.
  await app.ready();

  server.on('error', (err: Error) => {
    port.postMessage({ type: 'failed', message: err.message } satisfies WorkerMessage);
  });

  const done = (): void => {
    const bound = init.listen.kind === 'bind';
    const addr = server.address();
    port.postMessage({
      type: 'listening',
      fd: bound ? listeningFd(server) : null,
      port: bound && addr !== null && typeof addr === 'object' ? addr.port : null,
    } satisfies WorkerMessage);
  };

  if (init.listen.kind === 'bind') {
    const { port: p, host, reusePort } = init.listen;
    server.listen({ port: p, host, reusePort }, done);
  } else {
    server.listen({ fd: init.listen.fd }, done);
  }
}

main().catch((err: unknown) => {
  parentPort?.postMessage({
    type: 'failed',
    message: err instanceof Error ? err.message : String(err),
  } satisfies WorkerMessage);
});
