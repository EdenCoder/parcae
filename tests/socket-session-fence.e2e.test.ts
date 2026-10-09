/**
 * App-level pin for the socket session fence: an RPC dispatched while a
 * hello's token resolution is still in flight must get the 409 refusal
 * envelope, never the prior (or absent) session — and the same socket
 * must serve RPCs normally once the hello resolves. The reconciler's
 * unit tests pin its internal fences; this is the only test that
 * exercises the actual app.ts wiring: capture-before-dispatch, the 409
 * envelope, and recovery after reconciliation.
 */
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pako from 'pako';
import { decompress } from 'compress-json';
import { io as socketIo, type Socket } from 'socket.io-client';
import { createApp } from '@parcae/backend';
import type { AuthAdapter, AuthSession, ParcaeApp } from '@parcae/backend';
import { Document } from './models/document';
import {
  createPostgresTestDatabase,
  describePostgres,
} from './postgres-test';

const LATCHED_TOKEN = 'latched-token';
const TEST_ENV = [
  'DATABASE_URL',
  'ENSURE_SCHEMA',
  'NODE_ENV',
  'REDIS_URL',
  'RUN_CRONS',
  'RUN_JOBS',
] as const;

const session: AuthSession = {
  user: { id: 'user-latched', tenantId: 'tenant-a' },
};

let releaseLatch: () => void = () => {};
let latch: Promise<void> = Promise.resolve();

const auth: AuthAdapter = {
  async setup() {},
  async resolveRequest() {
    return null;
  },
  async resolveToken(token) {
    if (token !== LATCHED_TOKEN) return null;
    await latch;
    return session;
  },
};

const reservePort = async (): Promise<number> => {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve an integration-test port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
};

interface RpcEnvelope {
  success: boolean;
  result: unknown;
  error?: string;
  status?: number;
}

function callRpc(socket: Socket, path: string): Promise<RpcEnvelope> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no RPC response for ${path}`)),
      5_000,
    );
    socket.once(requestId, (frame: Uint8Array) => {
      clearTimeout(timer);
      // boundary: wire frames are gzip of compress-json, same as the SDK.
      const decoded = decompress(
        JSON.parse(pako.ungzip(frame, { to: 'string' })),
      ) as RpcEnvelope;
      resolve(decoded);
    });
    socket.emit('call', requestId, 'GET', path, {});
  });
}

describePostgres('socket session fence — app wiring', () => {
  const previousEnv = new Map<string, string | undefined>();
  const testsRoot = fileURLToPath(new URL('.', import.meta.url));
  let app: ParcaeApp;
  let baseUrl: string;
  let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
  let socket: Socket;

  beforeAll(async () => {
    for (const key of TEST_ENV) previousEnv.set(key, process.env[key]);
    database = await createPostgresTestDatabase();
    process.env.DATABASE_URL = database.url;
    process.env.ENSURE_SCHEMA = 'true';
    process.env.NODE_ENV = 'test';
    process.env.RUN_CRONS = 'false';
    process.env.RUN_JOBS = 'false';
    delete process.env.REDIS_URL;

    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    app = createApp({
      models: [Document],
      modelsPath: 'models',
      root: testsRoot,
      auth,
    });
    await app.start({ port });
  });

  afterAll(async () => {
    socket?.disconnect();
    if (app) await app.stop();
    if (database) await database.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(
    'refuses an RPC mid-hello with 409 and serves it after reconciliation',
    async () => {
      latch = new Promise<void>((resolve) => {
        releaseLatch = resolve;
      });

      socket = socketIo(baseUrl, {
        path: '/ws',
        transports: ['websocket'],
      });
      await new Promise<void>((resolve) => socket.once('connect', resolve));

      // An RPC before any hello has resolved: no reconciled session yet.
      const preHello = await callRpc(socket, '/v1/documents');
      expect(preHello.success).toBe(false);
      expect(preHello.status).toBe(409);
      expect(preHello.error).toContain('not reconciled');

      // Start a hello whose token resolution is latched open, then race
      // an RPC into the resolution window: the fence must refuse it
      // rather than dispatch it against the prior (absent) session.
      const helloAck = new Promise<{ userId: string | null }>((resolve) => {
        socket.emit('hello', { token: LATCHED_TOKEN }, resolve);
      });
      const midHello = await callRpc(socket, '/v1/documents');
      expect(midHello.success).toBe(false);
      expect(midHello.status).toBe(409);

      releaseLatch();
      const ack = await helloAck;
      expect(ack.userId).toBe('user-latched');

      // Same socket, reconciled session: the RPC now dispatches.
      const afterHello = await callRpc(socket, '/v1/documents');
      expect(afterHello.success).toBe(true);
      expect(afterHello.status).toBeUndefined();
    },
  );
});
