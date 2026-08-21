// Reads and rewrites ZIP archives, which is all a .docx is. The Worker needs
// this to swap one entry — word/document.xml — inside the lease template and
// hand back a valid Word file.
//
// No library: the runtime's own DecompressionStream and CompressionStream do
// the deflating, and the handful of ZIP structures are read and written by
// hand. site/admin/docx.js does the same thing in the browser for reading.
//
// Only the entry being replaced is recompressed. Every other entry — fonts,
// images, styles, the numbering definitions — is copied across still
// compressed, reusing the CRC and sizes the original archive already recorded.
// That keeps a rewrite cheap even though the template is about 400 KB.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// ---------------------------------------------------------------- reading

function locateEndOfCentralDirectory(view) {
  // The record sits at the very end, after an optional comment of up to 64 KB.
  const earliest = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

// Every entry in the archive, in central-directory order, each one carrying a
// view of its still-compressed bytes.
export function readEntries(buffer) {
  const view = new DataView(buffer);
  const end = locateEndOfCentralDirectory(view);
  if (end === -1) throw new Error("Not a valid .docx file.");

  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  const entries = [];
  let offset = view.getUint32(end + 16, true);

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("The .docx central directory is damaged.");
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    // The local header repeats the name and extra fields, and its lengths are
    // the authoritative ones for locating the data.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedSize = view.getUint32(offset + 20, true);

    entries.push({
      name: decoder.decode(new Uint8Array(buffer, offset + 46, nameLength)),
      method: view.getUint16(offset + 10, true),
      flags: view.getUint16(offset + 8, true),
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
      crc: view.getUint32(offset + 16, true),
      compressedSize,
      uncompressedSize: view.getUint32(offset + 24, true),
      externalAttributes: view.getUint32(offset + 38, true),
      bytes: new Uint8Array(buffer, dataOffset, compressedSize)
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflate(bytes, method) {
  if (method === METHOD_STORE) return bytes;
  if (method !== METHOD_DEFLATE) {
    throw new Error(`Unsupported compression in .docx (method ${method}).`);
  }
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readEntryText(entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`The .docx has no ${name}.`);
  return new TextDecoder().decode(await inflate(entry.bytes, entry.method));
}

// ---------------------------------------------------------------- writing

// Table-driven CRC-32, the checksum ZIP requires for every entry. Built once
// on first use rather than shipped as a 256-entry literal.
let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Deflating is an optimisation, not a requirement: a ZIP may mix stored and
// deflated entries freely, and Word opens either. If the runtime has no
// CompressionStream the entry is stored instead, costing size but nothing else.
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Response(bytes).body.pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// Replaces one entry's contents, leaving every other entry byte-for-byte as it
// was, and returns the rebuilt archive.
export async function replaceEntry(entries, name, text) {
  const raw = new TextEncoder().encode(text);
  const deflated = await deflateRaw(raw);

  const replacement = {
    method: deflated ? METHOD_DEFLATE : METHOD_STORE,
    crc: crc32(raw),
    uncompressedSize: raw.length,
    bytes: deflated || raw
  };

  let found = false;
  const rebuilt = entries.map((entry) => {
    if (entry.name !== name) return entry;
    found = true;
    // Clear any data-descriptor flag: sizes are known up front here, so the
    // local header carries them and no descriptor follows the data.
    return { ...entry, ...replacement, compressedSize: replacement.bytes.length, flags: entry.flags & ~0x08 };
  });

  if (!found) throw new Error(`The .docx has no ${name}.`);

  return writeZip(rebuilt);
}

function writeZip(entries) {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    if (!(entry.bytes instanceof Uint8Array)) {
      throw new Error(`Entry ${entry.name} is not a Uint8Array; its length would be read as undefined.`);
    }
    return { ...entry, nameBytes: encoder.encode(entry.name) };
  });

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.bytes.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);

  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  let offset = 0;

  for (const entry of prepared) {
    entry.localOffset = offset;

    view.setUint32(offset, LOCAL_SIGNATURE, true);
    view.setUint16(offset + 4, entry.method === METHOD_DEFLATE ? 20 : 10, true);
    view.setUint16(offset + 6, entry.flags, true);
    view.setUint16(offset + 8, entry.method, true);
    view.setUint16(offset + 10, entry.time, true);
    view.setUint16(offset + 12, entry.date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.bytes.length, true);
    view.setUint32(offset + 22, entry.uncompressedSize, true);
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // no extra field
    offset += 30;

    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    output.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }

  const centralStart = offset;

  for (const entry of prepared) {
    view.setUint32(offset, CENTRAL_SIGNATURE, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, entry.method === METHOD_DEFLATE ? 20 : 10, true);
    view.setUint16(offset + 8, entry.flags, true);
    view.setUint16(offset + 10, entry.method, true);
    view.setUint16(offset + 12, entry.time, true);
    view.setUint16(offset + 14, entry.date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.bytes.length, true);
    view.setUint32(offset + 24, entry.uncompressedSize, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number
    view.setUint16(offset + 36, 0, true); // internal attributes
    view.setUint32(offset + 38, entry.externalAttributes, true);
    view.setUint32(offset + 42, entry.localOffset, true);
    offset += 46;

    output.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  view.setUint32(offset, EOCD_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true); // this disk
  view.setUint16(offset + 6, 0, true); // disk with central directory
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true); // no archive comment

  return output;
}
