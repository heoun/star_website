-- Retire optional fields that have no lease-template or operational consumer.
-- Historical audit records remain intact. Run per environment before release.
begin;
lock table public.lease_settings, public.property_collaborations in share row exclusive mode;
update public.lease_settings
set field_values = field_values - 'manager.contact_name' - 'manager.email'
where field_values ?| array['manager.contact_name','manager.email'];
update public.property_collaborations
set base_settings = base_settings - 'manager.contact_name' - 'manager.email',
    settings_patch = settings_patch - 'manager.contact_name' - 'manager.email',
    version = version + 1, updated_at = now()
where base_settings ?| array['manager.contact_name','manager.email']
   or settings_patch ?| array['manager.contact_name','manager.email'];
commit;
