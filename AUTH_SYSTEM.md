> Cloud deployment update (September 2026): the application now uses Supabase PostgreSQL and private Storage, with Vercel hosting. The catalog starts empty and accounts are administrator-created. See [DEPLOYMENT.md](DEPLOYMENT.md) for current setup; local SQLite, self-signup, and bundled model instructions below describe the earlier implementation.

# Auth, Admin, and Hardware Model Access Implementation

## Runtime

- Backend: Express, SQLite, bcrypt password hashes, JWT bearer sessions.
- Frontend: Vite/TypeScript SPA with landing auth, `/app`, `/admin/login`, and `/admin`.
- Database file: `DATABASE_FILE`, default `./data/app.sqlite`.
- Built-in GLB catalog folder: `CATALOG_MODEL_DIR`, default `./data/models/catalog`.
- Uploaded GLB folder: `UPLOADED_MODEL_DIR`, default `./data/uploads/models`.
- Seed admin: `SEED_ADMIN_EMAIL=admin@gmail.com`, `SEED_ADMIN_PASSWORD=admin123`, `SEED_ADMIN_FORCE_PASSWORD_RESET=true`.
- Forced-reset users can authenticate only far enough to update their password; admin and model routes reject them until `/api/auth/password` clears the flag.

## Database Schema

- `roles`: `id`, `name` (`admin` or `user`).
- `users`: `id`, `email`, `password_hash`, `role_id`, `expires_at`, `force_password_reset`, timestamps.
- `hardware_models`: global GLB hardware catalog with `id`, `kind`, `name`, `detail`, `model_path`, `power_watts`, `metadata_json`, `is_builtin`, `created_by`, timestamps.
- `user_hardware_model_permissions`: many-to-many user/hardware-model grants with `granted_by` and `created_at`.

Expired users are rejected by auth middleware before protected routes run.

## API Surface

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/admin/login`
- `GET /api/auth/me`
- `POST /api/auth/password`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `PUT /api/admin/users/:id`
- `DELETE /api/admin/users/:id`
- `GET /api/admin/permissions`
- `PUT /api/admin/permissions`
- `GET /api/admin/models`
- `POST /api/admin/models` multipart `.glb` upload with `kind`, `name`, `detail`, `powerWatts`, and optional `metadata` JSON.
- `GET /api/models/accessible`
- `GET /api/models/:modelId/status`
- `GET /api/models/:modelId/file`

## Hardware Model Protocol

Every hardware model row maps to a configurator product object. Built-in rows are seeded from `src/config/products.ts`; uploaded rows use the admin-selected category plus optional metadata JSON for category-specific fields.

Useful metadata keys:

- Motherboard: `socket`, `memoryType`, `formFactor`.
- CPU: `socket`, `vendor`, `cores`, `threads`, `gamingScore`.
- RAM: `memoryType`, `capacityGb`, `speedMtps`.
- GPU: `vramGb`, `rasterScore`, `recommendedPsuWatts`.
- PSU: `capacityWatts`, `efficiency`.
- SSD: `capacityGb`.
- Fan: `count`.

Uploaded files are stored under `data/uploads/models` and are immediately visible in the admin model database. Model binaries are loaded through the authenticated `/api/models/:modelId/file` endpoint, so a standard user can only fetch uploaded or built-in models after an admin grants those model IDs.
