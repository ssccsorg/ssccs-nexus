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
  EDGEQUAKE_TENANT_ID: string;
  EDGEQUAKE_API_KEY: string;
  WORKSPACE_ID: string;
  // Optional overrides
  R2_PREFIX?: string;
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

    const engineName = match.pathname.groups['engine']!;
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
    ctx.waitUntil(runSync(engineName, env));

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
    const deletedKeys: string[] = [];

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
            console.log(`[${engineName}] deleting doc ${task.id} (R2 key: ${task.key || 'unknown'})`);
            await handler.deleteDocument(task.id, env);
            if (task.key) deletedKeys.push(task.key);
          } else if (task.type === 'upload' && task.key) {
            console.log(`[${engineName}] uploading ${task.key}...`);
            const obj = await env.ARTIFACT_BUCKET.get(task.key);
            if (!obj) {
              console.warn(`[${engineName}] R2 object not found: ${task.key}`);
              continue;
            }
            const buffer = await obj.arrayBuffer();
            const newId = await handler.uploadDocument(task.key, buffer, env);
            // Get the current ETag of the uploaded object
            const head = await env.ARTIFACT_BUCKET.head(task.key);
            updates[task.key] = { doc_id: newId, etag: head?.etag ?? '' };
            console.log(`[${engineName}] uploaded ${task.key} → doc_id=${newId}`);
          }
        } catch (e) {
          console.error(`[${engineName}] task failed: ${task.type} key=${task.key} id=${task.id}`, e);
        }
      }
      msg.ack();
    }

    // Apply mapping updates in one write (still eventual consistent but reduces within-batch races)
    if (Object.keys(updates).length > 0 || deletedKeys.length > 0) {
      const current =
        (await env.SYNC_KV.get('mapping', 'json')) as Record<string, { doc_id: string; etag: string }> || {};
      for (const [key, val] of Object.entries(updates)) {
        current[key] = val;
      }
      // Remove keys that were deleted from R2
      for (const key of deletedKeys) {
        delete current[key];
      }
      await env.SYNC_KV.put('mapping', JSON.stringify(current));
    }
  }
};

// ---------------------------------------------------------------------------
// Sync orchestrator (Producer → Queue → Consumer)
// ---------------------------------------------------------------------------
async function runSync(engineName: string, env: Env): Promise<void> {
  const CHUNK_SIZE = 10; // ≤50 tasks per message to stay under subrequest limit
  const R2_PREFIX = env.R2_PREFIX || 'ssccs/docs/';

  // 1. R2 inventory – only objects under the configured prefix
  const r2Objects = await env.ARTIFACT_BUCKET.list({ prefix: R2_PREFIX });
  const r2Map = new Map<string, string>();
  for (const obj of r2Objects.objects) {
    r2Map.set(obj.key, obj.etag);
  }
  console.log(`[${engineName}] found ${r2Map.size} objects in R2 under "${R2_PREFIX}"`);

  // 2. Previous mapping (KV)
  const prev: Record<string, { doc_id: string; etag: string }> =
    (await env.SYNC_KV.get('mapping', 'json')) || {};
  console.log(`[${engineName}] previous mapping has ${Object.keys(prev).length} entries`);

  // 3. Diff
  //    - Keys in prev but not in R2 → delete from engine
  //    - Keys in R2 but not in prev → upload
  //    - Keys in both but etag differs → delete old + upload new
  const tasks: Array<{ type: 'delete' | 'upload'; id?: string; key?: string }> = [];
  for (const [key, p] of Object.entries(prev)) {
    if (!r2Map.has(key)) {
      tasks.push({ type: 'delete', id: p.doc_id, key });
    }
  }
  for (const [key, etag] of r2Map) {
    const p = prev[key];
    if (!p || p.etag !== etag) {
      if (p) {
        tasks.push({ type: 'delete', id: p.doc_id, key });
      }
      tasks.push({ type: 'upload', key });
    }
  }
  console.log(`[${engineName}] sync plan: ${tasks.length} tasks (${tasks.filter(t => t.type === 'delete').length} deletes, ${tasks.filter(t => t.type === 'upload').length} uploads)`);

  // 4. Enqueue chunks
  for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
    const chunk = tasks.slice(i, i + CHUNK_SIZE);
    await env.SYNC_QUEUE.send({ chunk, engine: engineName });
  }
}

// Types
interface SyncTask {
  type: 'delete' | 'upload';
  id?: string;
  key?: string;
}
