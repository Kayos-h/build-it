---
version: alpha
name: BUILD//IT
description: A dark PC assembly workspace centered on interactive hardware previews.
colors:
  accent: '#a7f36b'
  surface: '#111c1d'
  text: '#e7f0eb'
typography:
  sans:
    fontFamily: 'Manrope, system-ui, sans-serif'
  mono:
    fontFamily: 'monospace'
rounded:
  DEFAULT: '7px'
spacing:
  panel-padding: '13px'
components:
  button: {}
  dialog: {}
  select: {}
---

# BUILD//IT design context

The established interface is a dark, green-accented PC workshop. The 3D assembly is the focal point; the deployment migration preserves existing layout, typography and colors. Runtime styles in `src/style.css` remain canonical; this document records the existing direction and does not generate styles.

English interface for PC builders and catalog administrators. No Japan-specific market requirements. The public landing page leads to account access; the protected app and admin routes are product tools. Account creation remains administrator-controlled, per the implemented login flow.

Use existing native selects, labeled inputs, dialog markup and `.form-message` feedback. Native popup geometry is accepted. Uploads must expose pending, success and recoverable error states without losing the selected file. Cloud drafts must only report success after the API confirms persistence. Errors remain within the affected workflow.

Model catalog starts empty by the owner's explicit deployment request. Do not invent hardware models, claim real benchmarks, or imply that missing catalog content is a loading error.
