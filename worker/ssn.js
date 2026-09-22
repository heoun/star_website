// Encrypts and decrypts applicant SSNs with AES-256-GCM. The key lives in the
// APP_ENCRYPTION_KEY Worker secret (32 random bytes, base64) and never reaches
// the database or the browser: Supabase stores only base64(iv || ciphertext),
// so a database leak alone cannot expose a single SSN.
//
// Generate the key once with:  openssl rand -base64 32

function keyBytes(env) {
  const raw = (env.APP_ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function encryptionReady(env) {
  return keyBytes(env) !== null;
}

async function importKey(env, usage) {
  const bytes = keyBytes(env);
  if (!bytes) throw new Error("APP_ENCRYPTION_KEY is missing or not 32 base64-encoded bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}

export async function encryptSsn(env, digits) {
  const key = await importKey(env, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(digits))
  );

  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptSsn(env, stored) {
  if (!stored) return null;

  try {
    const packed = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    const key = await importKey(env, "decrypt");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, 12) },
      key,
      packed.slice(12)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function formatSsn(digits) {
  return /^\d{9}$/.test(digits ?? "") ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : "";
}
