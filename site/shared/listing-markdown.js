import { Marked } from './vendor/marked.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeLink = href => {
  try { const url = new URL(href, 'https://example.invalid'); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : ''; } catch { return ''; }
};
// HTML is displayed as text. Links are allowlisted; embedded images stay in the media editor.
const markdown = new Marked({ gfm: true, breaks: true, renderer: {
  html({text}) { return escape(text); },
  link({href, tokens}) {
    const label = this.parser.parseInline(tokens), url = safeLink(href);
    return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  },
  image({text}) { return escape(text); }
}});
export function renderListingMarkdown(text) { return markdown.parse(String(text || ''), {async:false}); }
