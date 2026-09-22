// Store the desktop preference locally; phone navigation opens independently.
const root = document.documentElement;
const button = document.getElementById('sidebar-toggle');
const navigation = document.getElementById('sidebar-navigation');
const mobile = matchMedia('(max-width: 700px)');
const compact = matchMedia('(max-width: 860px)');
const storageKey = 'star.admin.sidebar.collapsed';
let preference = null;
try {
  const saved = localStorage.getItem(storageKey);
  if (saved === 'true' || saved === 'false') preference = saved === 'true';
} catch { /* Navigation still works when browser storage is unavailable. */ }
let mobileOpen = false;

function render() {
  const collapsed = preference ?? compact.matches;
  root.dataset.sidebarCollapsed = String(collapsed);
  root.dataset.mobileNavOpen = String(mobileOpen);
  const expanded = mobile.matches ? mobileOpen : !collapsed;
  const label = mobile.matches ? (expanded ? 'Close Menu' : 'Open Menu') : (expanded ? 'Collapse Sidebar' : 'Expand Sidebar');
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', label);
  button.title = label;
}
button.addEventListener('click', () => {
  if (mobile.matches) mobileOpen = !mobileOpen;
  else {
    preference = !(preference ?? compact.matches);
    try { localStorage.setItem(storageKey, String(preference)); } catch { /* Optional persistence. */ }
  }
  render();
});
navigation.addEventListener('click', event => {
  if (mobile.matches && event.target.closest('a')) {
    mobileOpen = false;
    button.focus();
    render();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mobile.matches && mobileOpen) {
    mobileOpen = false;
    button.focus();
    render();
  }
});
mobile.addEventListener('change', () => { mobileOpen = false; render(); });
compact.addEventListener('change', render);
render();
