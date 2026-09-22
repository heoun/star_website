import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
// Destructive retirements remain explicit, separate migrations.
export const schemaFiles=['schema','backoffice','workspace','administration','identity','storage','property-create','rental-flow','rental-membership','rental-drafts','rental-signing','account-security','applicant-auth','gip-auth'];
export function schemaRevision() {
  return createHash('sha256').update(schemaFiles.map(f=>readFileSync(`supabase/${f}.sql`,'utf8')).join('\n')).digest('hex');
}
export function schemaBundle() {
  const sql=schemaFiles.map(f=>`-- ${f}.sql\n${readFileSync(`supabase/${f}.sql`,'utf8').replace(/^(?:begin|commit);\s*$/gmi,'')}`).join('\n');
  return `begin;\n${sql}\nCREATE TABLE IF NOT EXISTS public.star_schema_release (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());\nALTER TABLE public.star_schema_release ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON public.star_schema_release FROM public,anon,authenticated;\nGRANT SELECT ON public.star_schema_release TO service_role;\nINSERT INTO public.star_schema_release VALUES (true,'${schemaRevision()}',now()) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,applied_at=excluded.applied_at;\nNOTIFY pgrst,'reload schema';\ncommit;\n`;
}
export async function checkSchema(env) {
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Configure the target database credentials.');
  const r=await fetch(env.SUPABASE_URL+'/rest/v1/star_schema_release?select=revision&singleton=eq.true',{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(15000)});
  if(!r.ok || (await r.json())[0]?.revision!==schemaRevision())throw new Error('Target schema is not ready for this revision. Apply the reviewed db:bundle SQL to this environment first.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const output=process.argv[2];if(!output)throw new Error('Usage: npm run db:bundle -- /path/to/release.sql');
  writeFileSync(output,schemaBundle());console.log(`Schema bundle prepared: ${output}\nRevision: ${schemaRevision()}`);
}
