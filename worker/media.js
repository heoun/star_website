// Media bytes live in the R2 bucket bound as env.MEDIA. Objects are keyed
// "<listing-id>/<uuid>.<ext>" and served at /media/<key>. Keys are random,
// so responses can be cached forever.

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif"
};

export const VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm"
};

export function isValidKey(key) {
  return KEY_PATTERN.test(key) && !key.includes("..") && key.length <= 200;
}

export function requireBucket(env) {
  if (!env.MEDIA) {
    throw new Error("The MEDIA R2 bucket binding is not configured.");
  }
  return env.MEDIA;
}

export async function putObject(env, key, contentType, body) {
  await requireBucket(env).put(key, body, { httpMetadata: { contentType } });
  return key;
}

export async function deleteObjectsByPrefix(env, prefix) {
  const bucket = requireBucket(env);
  let cursor;

  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteObject(env, key) {
  await requireBucket(env).delete(key);
}

export async function serveMedia(request, env, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", { status: 405 });
  }

  let key;
  try {
    key = decodeURIComponent(pathname.replace(/^\/media\//, ""));
  } catch {
    return new Response("Not found.", { status: 404 });
  }

  if (!isValidKey(key)) {
    return new Response("Not found.", { status: 404 });
  }

  let bucket;
  try {
    bucket = requireBucket(env);
  } catch {
    return new Response("Media storage is not configured.", { status: 503 });
  }

  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return new Response(null, { status: 404 });

    const headers = baseHeaders(object);
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  // An unusable Range header (malformed or multi-range) is ignored per
  // RFC 9110: the request is served as a normal full-body GET.
  const range = parseRange(request.headers.get("Range"));

  let object;
  try {
    object = await bucket.get(key, range ? { range } : undefined);
  } catch {
    // R2 throws when the requested range cannot be satisfied at all
    // (e.g. an offset at or past the end of the object).
    const head = await bucket.head(key);
    if (!head) return new Response("Not found.", { status: 404 });
    return new Response("Range not satisfiable.", {
      status: 416,
      headers: { "Content-Range": `bytes */${head.size}` }
    });
  }

  if (!object) {
    return new Response("Not found.", { status: 404 });
  }

  const headers = baseHeaders(object);

  if (range) {
    // R2 truncates a range that extends past the end of the object; the
    // window it actually returned is reported in object.range.
    const returned = object.range || {};
    const offset = returned.offset ?? range.offset ?? Math.max(0, object.size - (range.suffix ?? 0));
    const length = returned.length ?? Math.max(0, object.size - offset);
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function baseHeaders(object) {
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return headers;
}

// Supports the forms browsers actually send for media playback:
// "bytes=0-499" (offset+length), "bytes=500-" (offset), "bytes=-500" (suffix).
function parseRange(header) {
  if (!header) return null;

  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startText, endText] = match;

  if (startText === "" && endText === "") return null;

  if (startText === "") {
    const suffix = Number(endText);
    return suffix > 0 ? { suffix } : null;
  }

  const offset = Number(startText);
  if (endText === "") return { offset };

  const end = Number(endText);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}
