// Mirrors dealValues in worker/lease.js. These are explanations, never editable
// property defaults; actual deal values are resolved when preparing a rental.
export const PROPERTY_DOCUMENT_SOURCES=[
 {id:'tenant.names',label:'Applicant Names',source:'Application Form'},
 {id:'tenant.email',label:'Applicant Email',source:'Application Form'},
 {id:'tenant.mailing_address',label:'Applicant Mailing Address',source:'Application Form'},
 {id:'lease.commencement_date',label:'Move-in Date',source:'Application Form'},
 {id:'lease.end_date',label:'Lease End Date',source:'Application Form',detail:'Calculated from the move-in date and lease term.'},
 {id:'property.unit',label:'Unit Number',source:'Listing'},
 {id:'rent.monthly',label:'Monthly Rent',source:'Listing'},
 {id:'deposit.amount',label:'Security Deposit',source:'Lease Preparation',detail:'Defaults to one month of the Listing rent; confirmed for the rental.'},
 {id:'lease.effective_date',label:'Lease Date',source:'Lease Preparation',detail:'Set when the lease is prepared.'},
 {id:'lease.vacancy_lease_date',label:'Vacancy Lease Date',source:'Listing',detail:'Listing release date, with the lease preparation date as fallback.'},
 {id:'window_guard.mark_has_children',label:'Children in the Unit',source:'Application Form'},
 {id:'window_guard.mark_no_children',label:'No Children in the Unit',source:'Application Form'},
 {id:'window_guard.mark_wants_anyway',label:'Window Guard Request',source:'Application Form'},
 {id:'dhcr.mark_vacancy',label:'Vacancy Lease',source:'Property Settings',detail:'Derived from Lease Description in DHCR Electronic Lease Consent.'},
 {id:'dhcr.mark_renewal',label:'Renewal Lease',source:'Property Settings',detail:'Derived from Lease Description in DHCR Electronic Lease Consent.'}
];
