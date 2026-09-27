# UI ownership and cloud behavior

Authority: user deployment request, `AUTH_SYSTEM.md`, and the authorization checks in `server/http/auth.ts` and `server/routes/admin.ts`.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native select in `src/main.ts` | DESIGN.md | Native popup | Browser builder check |
| Form | Existing labeled forms and `.form-message` | Server validation | Create/edit, pending, error | Upload and draft browser checks |
| CRUD | `src/api.ts` and server routes | Server authorization and revisions | Model/user/draft | Cloud integration checks |
| Feedback | Existing inline `role=status` regions | API results | Pending/success/failure | Browser checks |
| Scrollbar | `src/style.css` | DESIGN.md | Existing global baseline | Narrow viewport check |

Uploads are authorized by an administrator before direct transfer into a private storage bucket. The API inspects the uploaded file before adding it to the catalog. Model downloads require a current entitlement before obtaining a short-lived signed URL. No service credential enters the client bundle.

Saved drafts belong to the signed-in user and are stored remotely. Deletion requires the current revision; concurrent changes produce a conflict rather than silent overwrite. Empty catalogs remain usable and administrators can upload content later.
