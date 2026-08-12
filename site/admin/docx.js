// Reads the text of a .docx entirely in the browser. A .docx is a ZIP archive
// whose word/document.xml holds the copy, so this unpacks just that entry with
// the platform's own DecompressionStream — no upload, no library.

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export async function readDocxText(file) {
  const buffer = await file.arrayBuffer();
  const entry = findEntry(new DataView(buffer), "word/document.xml");
  if (!entry) throw new Error("This .docx has no word/document.xml — is it a real Word file?");

  const bytes = await inflate(new Uint8Array(buffer, entry.dataOffset, entry.compressedSize), entry.method);
  return extractText(new TextDecoder().decode(bytes));
}

function findEntry(view, wantedName) {
  const end = locateEndOfCentralDirectory(view);
  if (end === -1) throw new Error("Not a valid .docx file.");

  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(new Uint8Array(view.buffer, offset + 46, nameLength));

    if (name === wantedName) {
      const localOffset = view.getUint32(offset + 42, true);
      // The local header repeats the name and extra fields, and its lengths
      // are the authoritative ones for locating the data.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      return {
        method: view.getUint16(offset + 10, true),
        compressedSize: view.getUint32(offset + 20, true),
        dataOffset: localOffset + 30 + localNameLength + localExtraLength
      };
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

function locateEndOfCentralDirectory(view) {
  // The record sits at the very end, after an optional comment of up to 64 KB.
  const earliest = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error(`Unsupported compression in .docx (method ${method}).`);

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function extractText(xml) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The .docx contents could not be read.");

  const paragraphs = document.getElementsByTagNameNS(WORD_NAMESPACE, "p");
  const lines = [];

  for (const paragraph of paragraphs) {
    const runs = paragraph.getElementsByTagNameNS(WORD_NAMESPACE, "t");
    let line = "";
    for (const run of runs) line += run.textContent;
    lines.push(line.trim());
  }

  return lines.join("\n");
}
