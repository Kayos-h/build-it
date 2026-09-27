> Cloud deployment update (September 2026): the application now uses Supabase PostgreSQL and private Storage, with Vercel hosting. The catalog starts empty and accounts are administrator-created. See [DEPLOYMENT.md](DEPLOYMENT.md) for current setup; local SQLite, self-signup, and bundled model instructions below describe the earlier implementation.

# BUILD//IT

A TypeScript / Three.js PC configurator with nine hardware dropdowns, estimated system power, modeled game FPS ranges, an interactive 3D preview, JWT authentication, per-user GLB hardware entitlements, uploadable models, and an admin panel.

## Run

Install Node.js 22+ first.

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:5173/`. The dev command runs the API on `127.0.0.1:3000` and Vite on `127.0.0.1:5173` with `/api` proxied to the backend.

The default seeded admin account is:

```text
admin@gmail.com
admin123
```

Set `JWT_SECRET`, `SEED_ADMIN_EMAIL`, and `SEED_ADMIN_PASSWORD` in `.env` before deployment. The seed admin is created with `forcePasswordReset` enabled by default.
On first login, the admin must change that seed password before the dashboard and model routes are available.

## Auth and model access

User signup/login happens from the landing page. The protected app fetches `/api/models/accessible` and populates the hardware dropdowns with only the case, RAM, GPU, and other GLB models assigned to the signed-in account.

The admin portal lives at `/admin/login` and is intentionally separate from standard user login. Admins can create/delete standard users, set account expiration timestamps, upload new `.glb` hardware models, browse the model database, and grant or revoke specific hardware models with per-user toggles.

See `AUTH_SYSTEM.md` for the database schema, API surface, upload behavior, and entitlement flow.

Every dropdown starts at **None**. No selected hardware is automatically replaced because of another selection. Clearing a parent removes its mounted descendants from the preview while preserving their dropdown values, so they can mount again when the parent is selected.

## Compatibility policy

The catalog is intentionally **unrestricted**. CPU socket, RAM generation, case form factor, cooler mounting/cooling allowance, PSU headroom, BIOS notes, and similar product-to-product compatibility rules do **not** block selections and do **not** trigger automatic fallback/replacement.

The selected motherboard's `formFactor` still controls the scene's connector/standoff layout (ATX, mATX, or ITX). This is a **3D layout choice**, not a hardware compatibility gate.

Unknown catalog IDs are rejected because they are invalid data, not because of hardware compatibility.

## 3D model assets

Every product stores a catalog `modelPath`, relative to `data/models/catalog`. The browser loads model binaries through `/api/models/:modelId/file`, so entitlements are enforced before a GLB is served:

```text
data/models/catalog/
├─ case/
│  ├─ aero_pc_case.glb
│  ├─ corsair-4000d.glb
│  └─ lian-li-o11.glb
├─ motherboard/
│  ├─ asus-b650.glb
│  └─ asus_prime_h510m-k.glb
├─ cpu/
│  ├─ am4_cpu.glb
│  └─ cpu.glb
├─ cooler/
│  ├─ cooler.glb
│  └─ cooler_2.glb
├─ ram/
│  ├─ vengeance-ddr4.glb
│  └─ vengeance-ddr5.glb
├─ gpu/
│  ├─ nvidia_geforce_rtx_5070.glb
│  ├─ rtx-4070.glb
│  └─ rx_480.glb
├─ psu/
│  ├─ aerocool_kcas_500w_atx.glb
│  ├─ psu.glb
│  └─ psu1.glb
├─ ssd/
│  ├─ 990-pro.glb
│  └─ m2ssd.glb
└─ fan/
   ├─ fan.glb
   └─ fan2.glb
```

To add another built-in product, place its `.glb` in the matching category folder and set that product's `modelPath` in `src/config/products.ts`. Uploaded admin models are stored under `data/uploads/models`. `AssetRepository` loads and caches the selected API file URL; `ConfigurationPreview` replaces a mounted instance when either `modelPath` or `modelTransform` changes.

## Procedural model transforms

Each product can optionally define a transform without editing the source GLB:

```ts
modelTransform: {
  scale: 0.92,                    // uniform scale multiplier after automatic fitting
  rotation: [0, Math.PI / 2, 0],  // extra XYZ Euler rotation, radians
  position: [0.002, 0, -0.001],  // extra local XYZ offset in metres
}
```

Scale can also be non-uniform:

```ts
modelTransform: { scale: [1, 0.98, 1.04] }
```

The loader first applies the category's built-in source orientation, automatically fits the selected mesh to the component envelope, then applies the product transform. This gives every SKU a code-controlled correction layer for different exported coordinate systems or physical proportions.

The model transform is attached to the selected product, so changing it causes the corresponding mounted model to reload/recalibrate without affecting unrelated parts.

## Preview behavior

Selected assets mount through the existing connector hierarchy. A child is mounted once its selected parent is present; this is a scene-graph dependency, not a hardware compatibility test. The complete preview contains 13 installed objects: case, motherboard, CPU, cooler, two RAM modules, GPU, PSU, SSD, and four fan instances.

The currently selected motherboard form factor chooses the active board/case layout. The actual selected motherboard GLB is loaded for **ATX, mATX, and ITX**; the preview no longer swaps to a generic/reference motherboard mesh for non-ATX boards.

The engine retains spatial collision and placement validation for the 3D scene. Those checks protect the scene graph from invalid mount states; they do not compare product SKUs or auto-select replacement hardware.

## Estimates

Game cards appear when all nine categories are selected and the catalog IDs are valid. The model covers Valorant, Counter-Strike 2, Fortnite, and Cyberpunk 2077 at 1920×1080 with the fixed presets defined in `src/config/products.ts`. FPS is a heuristic, not a measured benchmark.

Power is the sum of the selected products' modeled allowances. PSU capacity is separate from load; selecting a PSU never increases or decreases component load.

## Development checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:ui
```

`test:ui` uses Playwright/Chrome and validates the auth gate, protected configurator startup, model requests, unrestricted SKU pairing, None removal behavior, reset, RGB retention, and basic responsive/UI behavior. Start `npm run dev` before running it.
