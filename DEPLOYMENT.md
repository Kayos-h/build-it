# BUILD//IT cloud deployment

Frontend and Express API run on Vercel Hobby. Accounts, model metadata, permissions and saved builds live in Supabase PostgreSQL. Model binaries use the private `buildit-models` bucket. The initial catalog is intentionally empty.

The existing Supabase project's unrelated tables are untouched. BUILD//IT uses only `buildit_*` tables and functions; browser roles have no direct table access. The backend service key is server-only. Existing app JWT/bcrypt authentication is retained; Supabase Auth is not used for these application accounts.

## Environment

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_MODEL_BUCKET=buildit-models`, and a random `JWT_SECRET` in Vercel Production. Local development reads `.env`. Never prefix server credentials with `VITE_` or commit them. The original seed password is not deployed as an environment variable.

The additive SQL migration in `supabase/migrations/202609270001_buildit.sql` was executed once using `supabase db query --linked --file ...` to avoid interacting with another app's migration history. Do not run it again or reset this shared database. API cold starts perform a read-only health check and do not seed/delete records.

## Development and deployment

`npm ci`, `npm run dev`, `npm run build`, `npm test`.

`node --import tsx scripts/cloud-integration.ts` exercises real Supabase persistence, auth, permissions, uploads and drafts using temporary fixtures; fixtures are deleted afterward. Set `TEST_BASE_URL` to test the deployed API.

`vercel deploy --prod --yes --scope taxme` deploys this linked project. This directory is not currently a Git repository, so deployments are CLI-based.

## First login

Administrator credentials are saved only in ignored `.deployment-access.txt`. First login requires a password change. Administrators create accounts, upload models, edit calibration and assign user access. Public self-registration is not enabled.

## Storage and limits

Files must be self-contained GLB, embedded GLTF or OBJ, at most 50 MB. The backend issues an admin-bound upload receipt and signed upload URL. The browser transfers bytes directly to Supabase, then the backend inspects and registers the model. Downloads require current app authorization before a short-lived signed URL is issued. Previously issued download links can remain valid for up to 60 seconds after access revocation.

Keep within Supabase Free storage/transfer quotas and Vercel Hobby allowances. Free Supabase projects may pause after inactivity. Vercel Hobby is for personal/non-commercial use. No paid plan was enabled.
