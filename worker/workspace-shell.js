import {workspaceNavigation,workspaceHome,workspaceRoleLabel,workspaceGroups} from '../site/shared/workspace-navigation.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderWorkspaceShell(html,identity,environment={}) {
  // Explicit allowlist: never serialize cookies, auth tokens, or provider claims.
  const session={email:identity.email,role:identity.role,name:identity.name||'',owner:identity.owner===true,property_ids:identity.property_ids||[],property_collaboration_ids:identity.property_collaboration_ids||[],demo:identity.demo===true,...environment};
  const navigation=workspaceNavigation(session),groups=workspaceGroups(session),label=workspaceRoleLabel(session);
  html=html.replace(/<nav\b[^>]*id="sidebar-navigation"[^>]*>[\s\S]*?<\/nav>/,nav=>{
    const links=new Map([...nav.matchAll(/<a\b[^>]*data-route="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)].map(m=>[m[1],m[0]]));
    return '<nav class="nav" id="sidebar-navigation" aria-label="Main Navigation">'+Object.entries(navigation).map(([route,title])=>{
      const link=links.get(route);if(!link)throw Error('Missing workspace navigation');
      return (groups[route]?`<div class="nav-section">${esc(groups[route])}</div>`:'')+link.replace(/<span>[^<]*<\/span>/,`<span>${esc(title)}</span>`).replace(/<abbr title="[^"]*"/,`<abbr title="${esc(title)}"`);
    }).join('')+'</nav>';
  });
  html=html.replace('<body','<body data-role="'+esc(session.role)+'"')
    .replace(/(<a class="brand" href=")[^"]+/,`$1#/${workspaceHome(session)}`)
    .replace(/(<b id="who-role">)[\s\S]*?(<\/b>)/,(_,a,b)=>a+esc(session.name||label)+b)
    .replace(/(<span class="who" id="who">)[\s\S]*?(<\/span>)/,(_,a,b)=>a+esc(session.email)+b)
    .replace('<span class="badge" id="role-badge" hidden></span>',`<span class="badge" id="role-badge">${esc(label)}</span>`)
    .replace('<span class="avatar" id="avatar" aria-hidden="true"></span>',`<span class="avatar" id="avatar" aria-hidden="true">${esc((session.name||session.email||'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).slice(0,2).map(p=>p[0]?.toUpperCase()||'').join(''))}</span>`);
  const data=JSON.stringify(session).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  return html.replace('</body>',`<script id="workspace-session" type="application/json">${data}</script></body>`);
}
