# T_BIZ — Master Institutional Multi-Page Template

TechSites mother template for the **Lawyer & Accountant** niche, generalized as the canonical T_BIZ template for institutional multi-page sites.

Use this template **only** when a one-page deliverable (T_LP) is insufficient — e.g. complex service catalogs, team pages, multiple legal/regulatory pages.

## Active uses

- (currently no active derivations — kept in the library as fallback)
- Future: high-ticket institutional clients requesting multi-page sites

## Forbidden — do not do this

- **Do not remove** schema.org JSON-LD markup from any template page.
- **Do not hard-code** client business data (name, address, services). All values must flow from `config.json`.
- **Do not enable** Cloudflare AI Audit / Managed Robots on the destination zone — it caps Lighthouse SEO at 91-92.
- **Do not edit** the per-site WYSIWYG Worker structure unless updating the global TSW v1.1.1 implementation.
- **Do not use** this template for one-pagers — that is T_LP's job.

## Architecture

- Build: `node build.js` → `dist/`
- Hosted on Cloudflare Pages
- Per-site WYSIWYG (TSW v1.1.1) Worker + KV for client text editing
- See [`EXECUTION_GUIDE.md`](EXECUTION_GUIDE.md) for full schema, deploy steps, and validation gates

## Languages

T_BIZ supports BR/EN via `config.json` lang field. Each derived site is single-language.

## Required for every derivation

- `config.json` fully populated
- All schema.org markup intact
- Lighthouse SEO ≥ 95 (mobile + desktop)
- Cloudflare AI Audit OFF on the destination zone
- TSW WYSIWYG Worker deployed and tied to KV namespace

## Versioning

- v2.0 (2026-05-07) — Promoted to T_BIZ canonical. Repository marked as Template repository. README updated with hard rules.

---

**Owner:** Reynaldo Dallin (reynaldodallin@gmail.com)
**Master Plan:** REPROJETO-V3-MASTER-PLAN.md
