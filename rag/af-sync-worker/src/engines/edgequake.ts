// src/engines/edgequake.ts
// EdgeQuake engine handler

export class EdgeQuakeHandler {
  private base(env: Env): string {
    return env.EDGEQUAKE_API_HOST;
  }

  private headers(env: Env): HeadersInit {
    return { 'X-Workspace-ID': env.WORKSPACE_ID };
  }

  async listDocuments(env: Env): Promise<Array<{ id: string; title: string }>> {
    const res = await fetch(`${this.base(env)}/api/v1/documents?limit=50`, {
      headers: this.headers(env),
    });
    if (!res.ok) throw new Error(`EdgeQuake list failed: ${res.status}`);
    return res.json();
  }

  async deleteDocument(id: string, env: Env): Promise<void> {
    const res = await fetch(`${this.base(env)}/api/v1/documents/${id}`, {
      method: 'DELETE',
      headers: this.headers(env),
    });
    if (!res.ok) throw new Error(`EdgeQuake delete failed: ${res.status}`);
  }

  async uploadDocument(key: string, buffer: ArrayBuffer, env: Env): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), key);
    const res = await fetch(`${this.base(env)}/api/v1/documents/upload`, {
      method: 'POST',
      headers: this.headers(env),
      body: formData,
    });
    if (!res.ok) throw new Error(`EdgeQuake upload failed: ${res.status}`);
    const { id } = await res.json() as { id: string };
    return id;
  }
}