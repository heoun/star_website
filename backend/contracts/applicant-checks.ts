// Internal delivery rehearsal uses the same application and rental workflow.
// A provider owns payment/order state; application records store its receipts.
export interface TestRun { id: string; account_id: string; created_at: string }
export type ScreeningScenario = 'scored' | 'no_score' | 'failed';
export interface PaymentReceipt { id: string; application_id: string; status: 'pending' | 'paid' | 'failed'; amount: number; currency: 'USD'; simulated: true }
export interface ScreeningOrder { id: string; application_id: string; status: 'pending' | 'complete' | 'failed'; outcome?: 'scored' | 'no_score'; score?: number; reason?: string; completed_at?: string }
export interface ApplicantChecksProvider {
  payment(applicationId: string, outcome?: 'paid' | 'failed'): Promise<PaymentReceipt>;
  order(applicationId: string, materials: {consent: true; documents: {id:string;type:string}[]; scenario: ScreeningScenario}): Promise<ScreeningOrder>;
  result(applicationId: string): Promise<ScreeningOrder | null>;
}
