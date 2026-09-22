import type { ScreeningResult, WorkspaceApplication, WorkspaceCommand } from '../contracts/workspace.ts';
const text = (value: unknown, max=2000) => String(value ?? '').trim().slice(0,max);
export function reportEvidenceIssue(s: ScreeningResult | undefined, applicationId: string, allowMock=false): string {
  if (!s || s.status !== 'complete') return s?.status === 'not_connected' ? 'Credit-check provider not connected. Automatic screening is unavailable.' : 'Credit report pending.';
  if (s.application_id !== applicationId) return 'Credit report is not linked to this applicant.';
  if (s.mock && !allowMock) return 'Mock credit reports cannot be used outside the local demo.';
  if (!text(s.provider) || !text(s.reference) || !s.date || !Number.isFinite(Date.parse(s.date)) || Date.parse(s.date)>Date.now()) return 'Credit report provider, reference and valid report date are required.';
  if (s.mock) {
    if (s.source !== 'mock' || !s.reference?.startsWith('mock/')) return 'Invalid mock report.';
  } else {
    if (!['manual','provider'].includes(s.source || '')) return 'Credit report source is not verified.';
    try { const url=new URL(s.report_url || ''); if(url.protocol!=='https:' || url.username || url.password) throw new Error(); }
    catch { return 'A secure link to the actual credit report is required.'; }
    if(s.source==='manual' && (!text(s.verified_by) || !Number.isFinite(Date.parse(s.verified_at || '')))) return 'The external report must be recorded by an authorized reviewer.';
  }
  if(s.outcome==='no_score') return text(s.no_score_reason) && s.credit_score == null ? '' : 'Record the provider’s reason for returning no credit score, without a numeric score.';
  if(s.outcome!=='scored' || !Number.isInteger(s.credit_score) || s.credit_score!<300 || s.credit_score!>850 || !text(s.model) || s.model==='Model not recorded') return 'Record the credit score and scoring model from the report.';
  return '';
}
// A documented no-score report is complete evidence that the team must read
// before sharing; it is the one issue that is not the applicant's to resolve.
export const NO_SCORE_HOLD='Report returned no credit score; needs review. Automatic sharing is blocked.';
export function screeningIssue(row: WorkspaceApplication, allowMock=false): string {
  if(row.workspace?.screening_result?.status==='failed')return 'Credit-check provider failed to complete this report. Retry with the provider or start another internal test run.';
  const s=row.workspace?.screening_result;
  if (s?.status==='complete' && !['paid','waived'].includes(row.workspace?.checks?.fee || '')) return 'Credit report and payment records are inconsistent. Review payment evidence.';
  return reportEvidenceIssue(s,row.id,allowMock) || (s?.outcome==='no_score' ? NO_SCORE_HOLD : '');
}
export function externalReport(command: WorkspaceCommand, applicationId: string, actor: string): ScreeningResult {
  if(command.screening!=='received') return {status:'pending'};
  return {status:'complete',application_id:applicationId,source:'manual',mock:false,
    provider:text(command.report_provider,120),reference:text(command.report_reference,200),report_url:text(command.report_url),
    date:text(command.report_date,40),model:text(command.score_model,80),
    outcome:command.report_outcome==='no_score'?'no_score':'scored',no_score_reason:text(command.no_score_reason,500),
    credit_score:text(command.credit_score)?Number(command.credit_score):null,verified_by:actor,verified_at:new Date().toISOString()};
}
