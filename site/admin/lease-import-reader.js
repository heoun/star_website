import { readDocxText } from './docx.js';
import { MAX_TEXT } from './lease-import-extract.js';

export async function readLeaseFile(file, onProgress = () => {}) {
  if (!file || !/\.(pdf|docx)$/i.test(file.name)) throw new Error('Choose a PDF or DOCX lease.');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a non-empty file smaller than 20 MB.');
  const header = new Uint8Array(await file.slice(0,5).arrayBuffer());
  let text, warnings = [];
  if (/\.docx$/i.test(file.name)) {
    if (header[0] !== 80 || header[1] !== 75) throw new Error('This file is not a valid DOCX.');
    text = await readDocxText(file);
  } else {
    if (new TextDecoder().decode(header) !== '%PDF-') throw new Error('This file is not a valid PDF.');
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    const base = new URL('./vendor/pdfjs/', import.meta.url).href;
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
    const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer()), isEvalSupported:false, cMapUrl:`${base}cmaps/`, cMapPacked:true, standardFontDataUrl:`${base}standard_fonts/`, wasmUrl:`${base}wasm/`});
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 100) throw new Error('Choose a lease package with 100 pages or fewer.');
      const pages = []; let size = 0, empty = 0;
      for (let number=1; number<=pdf.numPages; number++) {
        onProgress(`Reading page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number), content = await page.getTextContent();
        let lastY = null, line = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const y = item.transform?.[5];
          if (lastY !== null && Math.abs(y - lastY) > 3) line += '\n';
          line += item.str + (item.hasEOL ? '\n' : ' '); lastY = y;
        }
        if (line.trim().length < 25) empty++;
        size += line.length;
        if (size > MAX_TEXT) throw new Error('This lease has too much text. Upload a smaller lease package.');
        pages.push(line); page.cleanup();
      }
      text = pages.join('\n');
      if (empty) warnings.push(`${empty} PDF page(s) contain little or no readable text. Review those pages manually; scanned pages and handwriting require OCR.`);
    } catch (error) {
      if (error.name === 'PasswordException') throw new Error('This PDF is password protected. Upload an unlocked copy.');
      throw error;
    } finally { await task.destroy(); }
  }
  if (text.length > MAX_TEXT) throw new Error('This lease has too much text. Upload a smaller lease package.');
  if (text.trim().length < 40) throw new Error('No readable lease text was found. For a scanned PDF, use an OCR text copy or enter the settings manually.');
  return {text, warnings};
}
