export function workspaceNavigation(session) {
  return session.owner ? {staff:'Accounts & Access'} : session.role==='manager'
    ? {applications:'Rentals',onboarding:'Landlord Onboarding',properties:'Properties & Settings',listings:'Listings',staff:'Accounts & Access',requests:'Change Requests'}
    : session.role==='agent' ? {applications:'My Rentals',listings:'Listings'}
    : {overview:'Awaiting My Decision',properties:'My Properties',leases:'Lease Documents'};
}
export const workspaceHome=session=>session.owner?'staff':session.role==='landlord'?'overview':'applications';
export const workspaceRoleLabel=session=>session.owner?'Platform owner':({manager:'Admin',agent:'Agent',landlord:'Landlord'}[session.role]||'Account');
export const workspaceGroups=session=>session.owner?{staff:'Administration'}:session.role==='manager'?{applications:'Workspace',properties:'Portfolio',staff:'Administration'}:session.role==='agent'?{applications:'Workspace'}:{overview:'Workspace'};
