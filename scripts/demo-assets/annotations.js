// Served only by scripts/demo-workspace.mjs, never bundled into the real site.
// Mark labels, not stored values: number/date/email controls remain valid.
document.documentElement.dataset.mockDemo = "true";
const style = document.createElement("style");
style.textContent = '.demo-mock-label{font-size:11px;font-weight:500;color:#7b602e;white-space:nowrap}.demo-mock-banner{padding:10px 16px;border-bottom:1px solid #e3d6b8;background:#fff6df;color:#6e5224;font:12px/1.5 system-ui}.demo-mock-banner strong{font-weight:700}';
document.head.append(style);
const banner = document.createElement("div");
banner.className = "demo-mock-banner";
banner.innerHTML = '<strong>MOCK DEMO</strong> · Applicant, property and lease fields are mock. Example terms are for testing only.';
const environment = document.getElementById("environment");
if (environment) environment.after(banner); else document.body.prepend(banner);
const selectors = '.cw-review-fact .k,.cw-proof > span,.prop-mobile-caption,.prop-listing-count,.prop-signer-label,dt,label,[data-setting-row] > .lbl,.prop-row.is-head > span:not(:empty),.desk-table th,.case-facts .k,.stat .k,.line > .lbl,.line > .k,.docrow > div:first-child > b';
function annotate(root) {
  const elements = [...(root.matches?.(selectors) ? [root] : []), ...root.querySelectorAll(selectors)];
  for (const node of elements) {
    if (node.closest('.demo-mock-label') || node.querySelector('.demo-mock-label') || /\(mock\)/i.test(node.textContent)
      || node.matches('dt') && node.querySelector('label') || !node.textContent.trim()) continue;
    const marker = document.createElement('span'); marker.className = 'demo-mock-label'; marker.textContent = ' (mock)';
    // Put the badge beside the caption, before its form control.
    if (node.matches('label')) {
      const control = [...node.children].find(c => c.matches('input,select,textarea'));
      if (control && control.type !== 'checkbox' && control.type !== 'radio') node.insertBefore(marker, control);
      else node.append(marker);
    } else node.append(marker);
  }
}
annotate(document.body);
new MutationObserver(records => {
  for (const r of records) {
    if (r.type === 'characterData') annotate(r.target.parentElement);
    if (r.type === 'childList' && r.target.matches?.(selectors)) annotate(r.target);
    for (const node of r.addedNodes) if (node.nodeType === 1 && !node.matches('.demo-mock-label')) annotate(node);
  }
}).observe(document.body, {childList:true,subtree:true,characterData:true});
