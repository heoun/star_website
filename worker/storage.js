// Object-storage adapter shared by the existing upload/download routes.
// Both buckets are private upstream. Only listing-media is exposed by /media/.
export function storageBucket(env, name) {
  if (env.STORAGE_BACKEND !== "supabase") {
    const bucket = name === "listing-media" ? env.MEDIA : env.APPLICANT_DOCS;
    if (!bucket) throw new Error("File storage is not configured.");
    return bucket;
  }
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase Storage is not configured.");
  const objectPath = path => {
    if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid file path.");
    return path.split("/").map(encodeURIComponent).join("/");
  };
  async function call(path, init = {}) {
    const response = await fetch(`${url}/storage/v1/${path}`, { ...init, signal: AbortSignal.timeout(60000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...init.headers } });
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.code === "NoSuchKey" || error.error === "Object not found" || error.message === "Object not found") return null;
      throw Object.assign(new Error("File storage request failed."), { status: response.status });
    }
    return response;
  }
  async function read(path, method, options) {
    const range = options?.range;
    const header = !range ? null : range.suffix ? `bytes=-${range.suffix}` : `bytes=${range.offset || 0}-${range.length ? (range.offset || 0) + range.length - 1 : ""}`;
    const response = await call(`object/authenticated/${name}/${objectPath(path)}`, { method, headers: header ? { Range: header } : {} });
    if (!response) return null;
    const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
    return { body: response.body, size: Number(returned?.[3] || response.headers.get("Content-Length") || 0),
      rangeIgnored: !!range && response.status === 200,
      httpMetadata: { contentType: response.headers.get("Content-Type") }, httpEtag: response.headers.get("ETag") || '""',
      ...(returned ? { range: { offset: Number(returned[1]), length: Number(returned[2]) - Number(returned[1]) + 1 } } : {}),
      arrayBuffer: () => response.arrayBuffer() };
  }
  async function remove(paths) {
    if (!paths.length) return;
    paths.forEach(objectPath);
    const response = await call(`object/${name}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
    if (!response) throw new Error("File storage bucket is unavailable.");
  }
  async function deletePrefix(prefix) {
    // All callers delete an application/listing directory, never a partial name.
    if (!prefix.endsWith("/")) throw new Error("Choose a file directory to delete.");
    const folder = prefix.slice(0, -1); objectPath(folder);
    for (;;) {
      const response = await call(`object/list/${name}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: folder, limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } }) });
      if (!response) throw new Error("File storage bucket is unavailable.");
      const rows = await response.json();
      if (!rows.length) return;
      const files = [];
      for (const row of rows) {
        const path = `${folder}/${row.name}`;
        if (row.id) files.push(path); else await deletePrefix(`${path}/`);
      }
      await remove(files);
      // Always re-read page zero after deleting, so offsets cannot skip files.
    }
  }
  return {
    get: (path, options) => read(path, "GET", options), head: path => read(path, "HEAD"),
    async put(path, body, options) {
      const response = await call(`object/${name}/${objectPath(path)}`, { method: "POST", body,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        headers: { "Content-Type": options?.httpMetadata?.contentType || "application/octet-stream", "x-upsert": "false" } });
      if (!response) throw new Error("File storage bucket is unavailable.");
    },
    delete: paths => remove(Array.isArray(paths) ? paths : [paths]), deletePrefix
  };
}
