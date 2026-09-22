// The uploaded document, on screen.
//
// There is one place the bytes come from and it already existed: GET
// /api/admin/documents/:id streams the object out of R2 with the content type
// it was stored under and `Content-Disposition: inline`. This adds no second
// path to the file — it points a frame at that endpoint. Nothing here renders
// a stand-in, and nothing here is shown unless the real file loaded.
//
// A checklist entry can hold several files: an ID has a front and a back, two
// paystubs are two uploads. So the viewer takes the whole entry and lets the
// reader move between its files without closing and reopening.

const DOCUMENT_URL = (id) => `/api/admin/documents/${encodeURIComponent(id)}`;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

let dialog;
let escapeHtml = (value) => String(value ?? "");
let state = { title: "", files: [], index: 0 };

export function initDocViewer(deps) {
  escapeHtml = deps.escapeHtml;
  dialog = document.getElementById("doc-viewer");

  dialog.addEventListener("click", (event) => {
    // The backdrop is the dialog element itself; anything inside it is a child.
    if (event.target === dialog) { dialog.close(); return; }

    const close = event.target.closest("[data-viewer-close]");
    if (close) { dialog.close(); return; }

    const pick = event.target.closest("[data-viewer-file]");
    if (pick) {
      state.index = Number(pick.dataset.viewerFile);
      paint();
    }
  });

  // Nothing is kept once it is shut: a stale frame pointing at a document from
  // a different application is worse than an empty one.
  dialog.addEventListener("close", () => {
    state = { title: "", files: [], index: 0 };
    dialog.querySelector("#viewer-stage").innerHTML = "";
  });
}

export function openDocViewer({ title, files, index = 0 }) {
  if (!Array.isArray(files) || files.length === 0) return;
  state = { title, files, index: Math.min(Math.max(index, 0), files.length - 1) };
  paint();
  if (!dialog.open) dialog.showModal();
}

function sizeText(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function stage(file) {
  const url = DOCUMENT_URL(file.id);
  const type = String(file.content_type || "").toLowerCase();

  if (type === "application/pdf") {
    return `<iframe src="${escapeHtml(url)}#view=FitH" title="${escapeHtml(file.file_name || "Document")}"></iframe>`;
  }

  if (IMAGE_TYPES.has(type)) {
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(file.file_name || "Uploaded document")}">`;
  }

  // HEIC, mostly: the applicant's phone uploaded it and no browser but Safari
  // will draw it. Say so rather than showing a broken frame.
  return `<div class="viewer-plain">
    <p><b>${escapeHtml(file.file_name || "This file")}</b> is a ${escapeHtml(type || "file type")}
       this browser will not draw.</p>
    <p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open it in a new tab</a>
       or download it below.</p>
  </div>`;
}

function paint() {
  const file = state.files[state.index];
  if (!file) return;
  const url = DOCUMENT_URL(file.id);

  dialog.querySelector("#viewer-title").textContent = state.title;
  dialog.querySelector("#viewer-kind").textContent =
    state.files.length > 1 ? `File ${state.index + 1} of ${state.files.length}` : "Uploaded document";

  const tabs = dialog.querySelector("#viewer-files");
  tabs.hidden = state.files.length < 2;
  tabs.innerHTML = state.files.map((entry, position) => `
    <button type="button" class="chip" data-viewer-file="${position}"
            aria-pressed="${position === state.index}">${
      escapeHtml(entry.file_name || `File ${position + 1}`)}</button>`).join("");

  dialog.querySelector("#viewer-stage").innerHTML = stage(file);

  const parts = [file.file_name, sizeText(file.size_bytes)].filter(Boolean);
  dialog.querySelector("#viewer-meta").textContent = parts.join(" · ");

  const open = dialog.querySelector("#viewer-open");
  open.href = url;
  const download = dialog.querySelector("#viewer-download");
  download.href = url;
  download.setAttribute("download", file.file_name || "document");
}
