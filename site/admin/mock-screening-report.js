const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function hasMockReport(member) {
  const report = member.workspace?.screening_result;
  return ['localhost','127.0.0.1','[::1]'].includes(location.hostname)
    && report?.mock === true && report.source === 'mock' && report.status === 'complete' && report.application_id === member.id;
}
export function openMockReport(member) {
  if (!hasMockReport(member)) return;
  document.getElementById('mock-screening-report')?.remove();
  const report = member.workspace.screening_result;
  const dialog = document.createElement('dialog');
  dialog.id = 'mock-screening-report';
  dialog.className = 'rg-report-dialog';
  dialog.setAttribute('aria-labelledby','mock-report-title');
  const fields = [
    ['Applicant',member.name],['Report Provider',report.provider],
    ['Report Reference',report.reference],['Report Date',report.date?.slice(0,10)],
    ['Score Model',report.model || 'Not applicable'],['Result',report.outcome === 'no_score' ? 'No credit score returned' : 'Credit score returned']
  ];
  dialog.innerHTML = `<header><div><span class="k">MOCK REPORT</span><h2 id="mock-report-title">Credit Report</h2></div><button type="button" data-close-report aria-label="Close Report" autofocus>Close</button></header>
    <p class="rg-report-notice">This preview uses the applicant’s simulated screening result. No live credit bureau was contacted.</p>
    <div class="rg-report-score"><span>Credit Score (mock)</span><strong>${esc(report.credit_score ?? 'No score')}</strong></div>
    <dl>${fields.map(([label,value])=>`<div><dt>${label} (mock)</dt><dd>${esc(value || 'Not provided')}</dd></div>`).join('')}</dl>
    ${report.no_score_reason ? `<p>${esc(report.no_score_reason)}</p>` : ''}`;
  const trigger = document.activeElement;
  dialog.querySelector('[data-close-report]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { dialog.remove(); if(trigger?.isConnected)trigger.focus(); }, {once:true});
  document.body.append(dialog);
  dialog.showModal();
}
