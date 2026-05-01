// src/engines/edgequake.ts
// EdgeQuake engine handler
//
// Headers required by EdgeQuake:
//   X-Tenant-ID       – tenant UUID or "default"
//   X-Workspace-ID    – workspace UUID or "default"
//   X-API-Key         – API key (if EDGEQUAKE_AUTH_ENABLED=true)
//   Authorization     – Bearer <token> (alternative to X-API-Key)

export class EdgeQuakeHandler {
  private base(env: Env): string {
    return env.EDGEQUAKE_API_HOST;
  }

  private headers(env: Env): HeadersInit {
    const h: Record<string, string> = {
      'X-Tenant-ID': env.EDGEQUAKE_TENANT_ID || 'default',
      'X-Workspace-ID': env.WORKSPACE_ID || 'default',
    };

    // If an API key is configured, send it (EdgeQuake accepts both formats)
    if (env.EDGEQUAKE_API_KEY) {
      h['X-API-Key'] = env.EDGEQUAKE_API_KEY;
    }

    return h;
  }

  async listDocuments(env: Env): Promise<Array<{ id: string; title: string }>> {
    const url = `${this.base(env)}/api/v1/documents?limit=200`;
    const res = await fetch(url, {
      headers: this.headers(env),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`EdgeQuake list failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async deleteDocument(id: string, env: Env): Promise<void> {
    const url = `${this.base(env)}/api/v1/documents/${id}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.headers(env),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`EdgeQuake delete failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
  }

  async uploadDocument(key: string, buffer: ArrayBuffer, env: Env): Promise<string> {
    const url = `${this.base(env)}/api/v1/documents/upload`;

    // EdgeQuake upload_file expects multipart/form-data with a "file" field
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), key);

    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(env),
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`EdgeQuake upload failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }
    const { document_id } = await res.json() as { document_id: string };
    return document_id;
  }
}
