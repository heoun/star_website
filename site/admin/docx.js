// Reads the text of a .docx entirely in the browser. A .docx is a ZIP archive
// whose word/document.xml holds the copy, so this unpacks just that entry with
// the platform's own DecompressionStream — no upload, no library.

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export async function readDocxText(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a Word file smaller than 20 MB.");
  const buffer = await file.arrayBuffer();
  const entry = findEntry(new DataView(buffer), "word/document.xml");
  if (!entry) throw new Error("This .docx has no word/document.xml — is it a real Word file?");

  if (entry.uncompressedSize > 8 * 1024 * 1024) throw new Error("This Word document contains too much text to read safely.");
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
        uncompressedSize: view.getUint32(offset + 24, true),
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
  const reader = stream.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error("This Word document contains too much text to read safely.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function extractText(xml) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The .docx contents could not be read.");

  const textOf = node => {
    let text = '';
    const walk = el => {
      if (el.namespaceURI === WORD_NAMESPACE && ['del','moveFrom'].includes(el.localName)) return;
      if (el.namespaceURI === WORD_NAMESPACE && el.localName === 't') {text += el.textContent;return;}
      if (el.namespaceURI === WORD_NAMESPACE && ['tab','br','cr'].includes(el.localName)) {text += el.localName === 'tab' ? '\t' : '\n';return;}
      for (const child of el.children) walk(child);
    };
    walk(node);return text.trim();
  };
  const paragraphs = node => [...node.getElementsByTagNameNS(WORD_NAMESPACE,'p')].map(textOf).join('\n');
  const lines=[];
  const body=document.getElementsByTagNameNS(WORD_NAMESPACE,'body')[0];
  for (const node of body.children) {
    if(node.localName==='tbl') {
      const rows=[...node.children].filter(n=>n.localName==='tr').map(row=>[...row.children].filter(n=>n.localName==='tc').map(paragraphs));
      const headers=rows[0] || [];
      // Side-by-side role/contact tables must remain separate columns, otherwise
      // a manager's address could inherit the neighbouring landlord heading.
      if(headers.length>1 && headers.every(h=>h.length<140 && /^(?:property manager|management|landlord|owner|lessor|tenant)\b/i.test(h))) {
        headers.forEach((heading,i)=>{lines.push(heading+':');for(const row of rows.slice(1))lines.push(row[i] || '');lines.push('');});
      } else for(const row of rows){
        if(row.length===2 && !row[0].includes('\n'))lines.push(row[0].replace(/[:：]$/,'')+':\t'+row[1]);
        else lines.push(row.join('\n'));
      }
    } else if(node.localName==='p')lines.push(textOf(node));
    else lines.push(paragraphs(node));
  }
  return lines.join('\n');
}
