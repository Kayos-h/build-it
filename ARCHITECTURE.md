> Cloud deployment update (September 2026): the application now uses Supabase PostgreSQL and private Storage, with Vercel hosting. The catalog starts empty and accounts are administrator-created. See [DEPLOYMENT.md](DEPLOYMENT.md) for current setup; local SQLite, self-signup, and bundled model instructions below describe the earlier implementation.

# Architecture

## Module map

| Module | Responsibility |
|---|---|
| `src/config/products.ts` | Typed SKU catalog metadata, GLB storage paths, optional per-SKU procedural transforms, power estimates, and FPS model. |
| `src/config/hardware.ts` | Form-factor board profiles, connector slots, scene bounds, obstacles, and spatial metadata. |
| `src/core/ConfigurationPreview.ts` | Reconciles the UI selection into the mounted scene and swaps assets when a path/transform changes. |
| `src/core/Assembly.ts` | Transactional scene graph, mount reservations, parenting, spatial validation, lifecycle, and resource release. |
| `src/graphics/AssetRepository.ts` | GLB loading/caching, Draco decoding, per-asset calibration, procedural transforms, materials, RGB, glass, SSD batching, and disposal. |
| `src/main.ts` | Native select UI, estimates, preview lifecycle, RGB, accessibility, keyboard focus, and error surfaces. |

## Product selection and compatibility

Product selection is intentionally authoritative. `resolveConfigurationChange()` updates only the requested category and never changes another selected SKU.

`validateConfiguration()` checks only that non-empty IDs exist in the catalog. It does not test CPU socket, memory generation, board/case pairing, cooler suitability, PSU headroom, BIOS support, or any other product-to-product compatibility relationship.

This distinction matters:

- **Catalog compatibility:** unrestricted; no automatic fallback or replacement.
- **Scene graph dependencies:** a child model needs its selected parent mounted before it can be placed in the hierarchy.
- **Spatial validation:** the 3D engine can still reject an installation if its geometry cannot satisfy the configured slot/collision/alignment constraints.

The last two are scene mechanics, not product compatibility. No SKU is silently substituted to satisfy them.

## Asset lifecycle

Every product has a stored `modelPath` such as `gpu/rtx-4070.glb`. The app maps accessible models to authenticated `/api/models/:modelId/file` URLs before rendering. `AssetRepository.source()` caches by `kind:modelPath`. Missing or failed paths are not silently redirected to a category default.

`ConfigurationPreview` compares both `modelPath` and `modelTransform`. If the path changes, the old instance is removed and its reservation/resource is released before the new model is mounted. If only the product label changes while the path and transform stay the same, the existing geometry is reused.

The browser-ready URL is:

```text
/api/models/<modelId>/file
```

## Procedural transforms

`ModelTransform` is applied after the built-in category orientation and automatic envelope fitting:

```ts
interface ModelTransform {
  scale?: number | readonly [number, number, number];
  rotation?: readonly [number, number, number];
  position?: readonly [number, number, number];
}
```

The order is:

```text
GLB source
  → category source orientation
  → automatic envelope fitting
  → optional product rotation
  → optional product scale multiplier
  → optional product local position offset
  → connector-local mounting through Assembly/SlotNode
```

This keeps source GLBs immutable while allowing per-SKU corrections for exported coordinate systems and relative proportions.

## Form factors

`BOARD_PROFILES` defines ATX, mATX, and ITX board envelopes and connector positions. The selected motherboard's `formFactor` selects the active profile. The actual catalog GLB is always loaded; there is no generic reference-board fallback.

The connector positions are still configured scene metadata. A new commercial board can therefore be visually scaled/oriented correctly even when its detailed component landmarks differ from the current generic connector profile, but exact socket/DIMM/M.2/PCIe alignment may require a product-specific `modelTransform` or richer landmark metadata.

## Scene lifecycle

`ConfigurationPreview.setProducts()` captures the selection and synchronously prunes mounts whose parent chain, asset path, or transform is no longer current. `load()` serializes reconciliation into a shared operation and advances to the newest selection revision.

`Assembly.install()` reserves a mount before loading. Stale async loads are cancelled through `AbortController`. `Assembly.remove()` removes descendants and aborts dependent pending requests. `reset()` clears the complete graph and all reservations.

The graph uses connector-local identity transforms for logical component roots. Imported mesh corrections live inside the asset root, so model calibration does not change descendant slot transforms.

## Spatial validation

Spatial validation uses the existing `CollisionWorld`, configured component bounds, case interior, obstacles, and the GPU bracket alignment constraint. This protects the scene layout, but it does not inspect product compatibility metadata and never chooses another SKU.

## Tests

- `scripts/products.test.ts` covers the current catalog, all 21 supplied GLBs, unrestricted pairing, direct selection changes, invalid IDs, power accounting, and FPS output.
- `scripts/preview.test.ts` covers empty startup, parent-chain mounting, path/transform replacement, cancellation, retries, reset, and selected form-factor propagation.
- `scripts/spatial.test.ts` covers graph parenting, slots, collisions, reservations, and alignment mechanics.
- `scripts/interaction.test.ts` covers ray casting, snap fallback, drag/keyboard interaction, and camera focus behavior.
- `scripts/smoke-test.mjs` covers the browser-facing selection flow and actual model URLs.
