import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '@parcae/backend';
import type {
  AuthAdapter,
  AuthSession,
  ParcaeApp,
} from '@parcae/backend';
import { createClient } from '@parcae/sdk';
import type { ParcaeClient } from '@parcae/sdk';
import { Document } from './models/document';
import {
  createPostgresTestDatabase,
  describePostgres,
} from './postgres-test';

const TOKEN_A = 'tenant-a-token';
const TOKEN_B = 'tenant-b-token';
const TEST_ENV = [
  'DATABASE_URL',
  'ENSURE_SCHEMA',
  'NODE_ENV',
  'REDIS_URL',
  'RUN_CRONS',
  'RUN_JOBS',
] as const;

interface WireDocument {
  id: string;
  type: string;
  tenantId: string;
  title: string;
  revision: number;
}

interface DocumentList {
  total: number;
  totalCount: number;
  documents: WireDocument[];
}

interface ApiEnvelope<T> {
  success: boolean;
  result: T | null;
  error?: string;
}

interface TestRequest {
  headers?: {
    authorization?: string | string[];
  };
}

const sessions: Record<string, AuthSession> = {
  [TOKEN_A]: { user: { id: 'user-a', tenantId: 'tenant-a' } },
  [TOKEN_B]: { user: { id: 'user-b', tenantId: 'tenant-b' } },
};

const resolveToken = (token: string | null): AuthSession | null =>
  token ? sessions[token] ?? null : null;

const auth: AuthAdapter = {
  async setup() {},
  async resolveRequest(req: TestRequest) {
    const value = req.headers?.authorization;
    const authorization = Array.isArray(value) ? value[0] : value;
    return resolveToken(
      authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : null,
    );
  },
  async resolveToken(token) {
    return resolveToken(token);
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
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
};

describePostgres('createApp HTTP and SocketTransport integration', () => {
  const previousEnv = new Map<string, string | undefined>();
  const testsRoot = fileURLToPath(new URL('.', import.meta.url));
  let app: ParcaeApp;
  let baseUrl: string;
  let clientA: ParcaeClient;
  let clientB: ParcaeClient;
  let createdA: WireDocument;
  let createdB: WireDocument;
  let isStopped = false;
  let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>;

  const request = async <T>(
    method: string,
    path: string,
    token: string | null,
    data?: unknown,
  ): Promise<{ status: number; body: ApiEnvelope<T> }> => {
    const headers = new Headers();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    // boundary: fetch JSON is external protocol data verified by assertions below.
    const body = await response.json() as ApiEnvelope<T>;
    return { status: response.status, body };
  };

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

    clientA = createClient({
      url: baseUrl,
      getToken: async () => TOKEN_A,
    });
    clientB = createClient({
      url: baseUrl,
      getToken: async () => TOKEN_B,
    });
    await Promise.all([clientA.session.ready, clientB.session.ready]);

    createdA = await clientA.post('/documents', {
      title: 'Tenant A draft',
      tenantId: 'tenant-b',
      revision: 99,
      secret: 'a-secret',
    });
    createdB = await clientB.post('/documents', {
      title: 'Tenant B draft',
      tenantId: 'tenant-a',
      revision: 99,
      secret: 'b-secret',
    });
  });

  afterAll(async () => {
    clientA?.dispose();
    clientB?.dispose();
    if (app && !isStopped) await app.stop();
    if (database) await database.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses hello authentication and enforces create projection', () => {
    expect(clientA.session.state).toMatchObject({
      status: 'authenticated',
      userId: 'user-a',
    });
    expect(createdA).toMatchObject({
      tenantId: 'tenant-a',
      revision: 0,
      title: 'Tenant A draft',
    });
    expect(createdB).toMatchObject({
      tenantId: 'tenant-b',
      revision: 0,
    });
    expect(createdA).not.toHaveProperty('secret');
    expect(createdB).not.toHaveProperty('secret');
  });

  it('returns only the authenticated tenant through a bound model context', async () => {
    const ClientDocument = clientA.bind(Document);
    const documents = await ClientDocument.where({}).find();

    expect(documents.map((document) => document.id)).toEqual([createdA.id]);
    expect(documents[0]).toMatchObject({
      tenantId: 'tenant-a',
      title: 'Tenant A draft',
    });
    expect(documents[0]?.secret).toBe('');
  });

  it('denies anonymous lists over HTTP and socket', async () => {
    const anonymous = createClient({
      url: baseUrl,
      getToken: async () => null,
    });

    try {
      await anonymous.session.ready;
      expect(anonymous.session.state.status).toBe('anonymous');
      await expect(
        anonymous.get('/documents', { __subscribe: false }),
      ).rejects.toThrow('Forbidden');

      const response = await request<DocumentList>(
        'GET',
        '/v1/documents',
        null,
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Forbidden',
      });
    } finally {
      anonymous.dispose();
    }
  });

  it('prevents cross-tenant reads and writes', async () => {
    const ClientDocument = clientA.bind(Document);
    await expect(ClientDocument.findById(createdB.id)).resolves.toBeNull();
    await expect(
      clientA.get(`/documents/${createdB.id}`),
    ).rejects.toThrow('document not found');
    await expect(
      clientA.put(`/documents/${createdB.id}`, { title: 'Stolen' }),
    ).rejects.toThrow('document not found');

    const response = await request<WireDocument>(
      'PATCH',
      `/v1/documents/${createdB.id}`,
      TOKEN_A,
      { ops: [{ op: 'replace', path: '/title', value: 'Stolen' }] },
    );
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('document not found');
  });

  it('keeps PUT and PATCH readonly fields protected and private fields hidden', async () => {
    const put = await request<WireDocument>(
      'PUT',
      `/v1/documents/${createdA.id}`,
      TOKEN_A,
      {
        title: 'Tenant A published',
        tenantId: 'tenant-b',
        revision: 42,
        secret: 'updated-secret',
      },
    );
    expect(put.status).toBe(200);
    expect(put.body.result).toMatchObject({
      title: 'Tenant A published',
      tenantId: 'tenant-a',
      revision: 0,
    });
    expect(put.body.result).not.toHaveProperty('secret');

    const patched = await clientA.patch(`/documents/${createdA.id}`, {
      ops: [{ op: 'replace', path: '/title', value: 'Tenant A patched' }],
    });
    expect(patched).toMatchObject({
      title: 'Tenant A patched',
      tenantId: 'tenant-a',
      revision: 0,
    });
    expect(patched).not.toHaveProperty('secret');

    await expect(
      clientA.patch(`/documents/${createdA.id}`, {
        ops: [{ op: 'replace', path: '/revision', value: 1 }],
      }),
    ).rejects.toThrow('Field "revision" is read-only');
  });

  it('returns the same scoped list over HTTP and socket RPC', async () => {
    const socket = await clientA.get('/documents', { __subscribe: false });
    const http = await request<DocumentList>(
      'GET',
      '/v1/documents',
      TOKEN_A,
    );

    expect(http.status).toBe(200);
    expect(http.body.result).toEqual(socket);
    expect(socket.documents).toHaveLength(1);
    expect(socket.documents[0]).not.toHaveProperty('secret');
  });

  it('shuts down sockets, HTTP, and persistence cleanly', async () => {
    clientA.dispose();
    clientB.dispose();
    await app.stop();
    isStopped = true;

    await expect(fetch(`${baseUrl}/v1/health`)).rejects.toThrow();
  });
});
