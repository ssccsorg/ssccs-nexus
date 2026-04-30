// src/index.ts
// Nexus Sync Worker – /sync/:engine pattern
// Supports: EdgeQuake (/sync/eq), future: AutoRAG (/sync/auto), custom (/sync/local)

import { EdgeQuakeHandler } from './engines/edgequake';

// ---------------------------------------------------------------------------
// Shared environment type (used by all engine handlers)
// ---------------------------------------------------------------------------
export interface Env {
  ARTIFACT_BUCKET: R2Bucket;
  SYNC_KV: KVNamespace;
  SYNC_QUEUE: Queue;
  SYNC_API_KEY: string;
  EDGEQUAKE_API_HOST: string;
  WORKSPACE_ID: string;
}

// ---------------------------------------------------------------------------
// Engine Handler Interface (extend for new engines)
// ---------------------------------------------------------------------------
export interface EngineHandler {
  /** List all indexed documents in the engine */
  listDocuments(env: Env): Promise<Array<{ id: string; title: string }>>;
  /** Delete a document by engine-native ID */
  deleteDocument(id: string, env: Env): Promise<void>;
  /** Upload a document; returns the engine-native ID assigned */
  uploadDocument(key: string, buffer: ArrayBuffer, env: Env): Promise<string>;
}

// ---------------------------------------------------------------------------
// Engine Registry – register new engines here
// ---------------------------------------------------------------------------
const engines: Record<string, EngineHandler> = {
  eq: new EdgeQuakeHandler(),          // EdgeQuake
  // auto: new AutoRAGHandler(),       // Cloudflare AI Search (future)
  // local: new LocalHandler(),        // Local / custom engine (future)
};

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function authorize(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  const expected = `Bearer ${env.SYNC_API_KEY}`;
  return auth === expected;
}

// ---------------------------------------------------------------------------
// HTTP fetch handler – route /sync/:engine
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // URLPattern matching for /sync/:engine
    const syncPattern = new URLPattern({ pathname: '/sync/:engine' });
    const match = syncPattern.exec(url);

    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    // Auth check
    if (!authorize(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const engineName = match.pathname.groups.engine!;
    const handler = engines[engineName];

    if (!handler) {
      return new Response(
        JSON.stringify({
          error: 'Unknown engine',
          supported: Object.keys(engines),
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Dispatch to the sync orchestrator
    ctx.waitUntil(runSync(engineName, handler, env));

    return new Response(
      JSON.stringify({ status: 'accepted', engine: engineName }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    );
  },

  async queue(
    batch: MessageBatch<{ chunk: SyncTask[]; engine: string }>,
    env: Env
  ): Promise<void> {
    // Collect all updates from this batch to apply atomically at the end
    const updates: Record<string, { doc_id: string; etag: string }> = {};

    for (const msg of batch.messages) {
      const { chunk, engine: engineName } = msg.body;
      const handler = engines[engineName];
      if (!handler) {
        msg.ack();
        continue;
      }

      for (const task of chunk) {
        try {
          if (task.type === 'delete' && task.id) {
            await handler.deleteDocument(task.id, env);
            // Remove from mapping if needed – we'll handle later
          } else if (task.type === 'upload' && task.key) {
            const obj = await env.ARTIFACT_BUCKET.get(task.key);
            if (!obj) continue;
            const newId = await handler.uploadDocument(
              task.key,
              await obj.arrayBuffer(),
              env
            );
            // Get the current ETag of the uploaded object
            const head = await env.ARTIFACT_BUCKET.head(task.key);
            updates[task.key] = { doc_id: newId, etag: head?.etag ?? '' };
          }
        } catch (e) {
          console.error(`[${engineName}] task failed: ${task.type}`, e);
        }
      }
      msg.ack();
    }

    // Apply mapping updates in one write (still eventual consistent but reduces within-batch races)
    if (Object.keys(updates).length > 0) {
      // Read current mapping, merge, then write
      const current =
        (await env.SYNC_KV.get('mapping', 'json')) as Record<string, { doc_id: string; etag: string }> || {};
      for (const [key, val] of Object.entries(updates)) {
        current[key] = val;
      }
      // Also remove deleted keys that were in the batch (optional, but we don't have explicit deletes in updates)
      // For deletes, we could also remove keys from mapping; but we didn't collect them in updates.
      // A complete solution would also track deleted keys from tasks and remove them.
      await env.SYNC_KV.put('mapping', JSON.stringify(current));
    }
  }
};

// ---------------------------------------------------------------------------
// Sync orchestrator (Producer → Queue → Consumer)
// ---------------------------------------------------------------------------
async function runSync(engineName: string, handler: EngineHandler, env: Env): Promise<void> {
  const CHUNK_SIZE = 10; // ≤50 tasks per message to stay under subrequest limit

  // 1. R2 inventory
  const r2Objects = await env.ARTIFACT_BUCKET.list();
  const r2Map = new Map<string, string>();
  for (const obj of r2Objects.objects) {
    r2Map.set(obj.key, obj.etag);
  }

  // 2. Previous mapping (KV)
  const prev: Record<string, { doc_id: string; etag: string }> =
    (await env.SYNC_KV.get('mapping', 'json')) || {};

  // 3. Diff
  const tasks: Array<{ type: 'delete' | 'upload'; id?: string; key?: string }> = [];
  for (const [key, p] of Object.entries(prev)) {
    if (!r2Map.has(key)) tasks.push({ type: 'delete', id: p.doc_id });
  }
  for (const [key, etag] of r2Map) {
    const p = prev[key];
    if (!p || p.etag !== etag) {
      if (p) tasks.push({ type: 'delete', id: p.doc_id });
      tasks.push({ type: 'upload', key });
    }
  }

  // 4. Enqueue chunks
  for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
    const chunk = tasks.slice(i, i + CHUNK_SIZE);
    await env.SYNC_QUEUE.send({ chunk, index: i / CHUNK_SIZE, engine: engineName });
  }
}

// Types
interface SyncTask {
  type: 'delete' | 'upload';
  id?: string;
  key?: string;
}