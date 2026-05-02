# Template — Lawyer & Accountant

Master template for the **Lawyer & Accountant** niche, part of the TechSites / PixelForge factory. Deployed via GitHub → Cloudflare Pages → optional WYSIWYG (TSW v1.1.1) Worker.

---

## 1. Stack

| Layer | Tech |
|---|---|
| Markup | HTML5 + Tailwind CDN |
| Styles | `src/assets/style.css` (CSS variables only) |
| Build | `node build.js` (zero external npm deps, Node 18+) |
| Hosting | Cloudflare Pages — `dist/` |
| CMS | TSW Standalone v1.1.1 (`assets/js/techsites-wysiwyg-standalone.js`) |
| Backend | Cloudflare Worker `tsw-lawyer-accountant` + KV namespace `TSW_LAWYER_ACCOUNTANT` |

---

## 2. Niche JSON Schema (v2.1)

`config.json` exposes the following top-level keys consumed by `{{placeholders}}`:

```jsonc
{
  "schema":              "techsites.master-template/v2.1",
  "niche":               { "slug", "name", "vertical" },
  "site":                { "id", "name", "tagline", "description", "url", "language", "locale", "year" },
  "brand":               { "logo_text", "logo_subtitle", "primary_color", "accent_color", "neutral_color", "font_family", "font_serif", "border_radius" },
  "contact":             { "phone_label", "phone_href", "email", "address_line1", "address_line2", "hours_weekdays", "hours_saturday", "hours_sunday" },
  "nav":                 { "home_label", "services_label", "about_label", "team_label", "testimonials_label", "contact_label", "cta_label" },
  "hero":                { "eyebrow", "title", "subtitle", "primary_cta_label", "primary_cta_href", "secondary_cta_label", "secondary_cta_href", "image_url", "image_alt", "trust_label", "stat_one_value", "stat_one_label", "stat_two_value", "stat_two_label", "stat_three_value", "stat_three_label" },
  "about":               { "eyebrow", "title", "body_one", "body_two", "highlight_one", "highlight_two", "highlight_three", "image_url", "image_alt" },
  "services_section":    { "eyebrow", "title", "subtitle" },
  "services":            [ { "icon", "title", "summary", "link_label", "link_href" } ],
  "features_section":    { "eyebrow", "title", "subtitle" },
  "features":            [ { "icon", "title", "summary" } ],
  "team_section":        { "eyebrow", "title", "subtitle" },
  "team":                [ { "name", "role", "credentials", "bio", "image_url", "image_alt" } ],
  "testimonials_section":{ "eyebrow", "title", "subtitle" },
  "testimonials":        [ { "name", "role", "rating", "quote", "image_url", "image_alt" } ],
  "faq_section":         { "eyebrow", "title", "subtitle" },
  "faq":                 [ { "question", "answer" } ],
  "cta_section":         { "eyebrow", "title", "subtitle", "form_*_label", "form_*_placeholder", "form_consent_label", "form_submit_label", "trust_one", "trust_two", "trust_three" },
  "footer":              { "tagline", "newsletter_label", "newsletter_placeholder", "newsletter_button", "rights", "disclaimer", "license", "links_*_label", "social_*_label" },
  "wysiwyg":             { "password", "site_id", "worker_url", "allowed_pages" },
  "items":               [ { "label", "title", "summary", "price", "duration", "image_url", "image_alt", "cta_label", "cta_href" } ]
}
```

### `data-editable` convention

- Naming: `pagina_secao_elemento` (snake_case, page → section → element).
- Allowed on text leaves only: `h1, h2, h3, h4, p, a, li, span, blockquote, strong, small, figcaption, dt, button`.
- **Forbidden** on containers: `section, div, article, header, footer, svg, main, aside, nav`.
- An element either uses a `{{placeholder}}` **or** `data-editable` — never both (no double authority).
- Keys are unique per page. Min 40, max 200 per page.

---

## 3. Local development

```bash
# install nothing — there are no npm deps
node build.js
npx serve dist
```

`build.js` reads `config.json` (or `CLIENT_JSON_URL` if set) and emits `dist/`.

---

## 4. Git workflow

```bash
cd /tmp/template-lawyer-accountant
git init -b main
git add .
git commit -m "Initial commit: Template Lawyer & Accountant v1.0.0"
gh repo create reynaldodallin/template-lawyer-accountant --public --source=. --push
```

---

## 5. Cloudflare Pages

| Setting | Value |
|---|---|
| Account ID | `26b19ee17142012acbf267bed32581c0` |
| Project name | `template-lawyer-accountant` |
| Production branch | `main` |
| Build command | `node build.js` |
| Build output dir | `dist` |
| Env: `CLIENT_JSON_URL` | raw URL of `config.json` on `main` |
| Env: `NODE_VERSION` | `18` |

After project creation, generate a **Deploy Hook** named `n8n-trigger`. The webhook URL is consumed by the n8n orchestrator to redeploy on config changes.

---

## 6. WYSIWYG Worker + KV

| Item | Value |
|---|---|
| KV namespace | `TSW_LAWYER_ACCOUNTANT` |
| Worker name | `tsw-lawyer-accountant` |
| `SITE_ID` | `lawyer-accountant-master` |
| `ALLOWED_PAGES` | `["index.html"]` |
| `ALLOWED_ORIGINS` | `https://template-lawyer-accountant.pages.dev` + `*.pages.dev` regex |
| Endpoints | `GET /health`, `GET /api/load`, `POST /api/save`, `OPTIONS /api/save` |
| KV binding name | `TSW_KV` |

After the worker is deployed, the `assets/js/techsites-wysiwyg.config.js` (and `config.json → wysiwyg.worker_url`) must point to `https://tsw-lawyer-accountant.<account-subdomain>.workers.dev`.

---

## 7. Deploy hook URL

Consumed by the n8n workflow node `[Lawyer-Accountant] Redeploy on config change`:

```
https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/447c6c46-013f-4e9d-925e-5fad572bacba
```

KV namespace ID: `8d29fc830c52419cbf706fee8376fb2f`

Worker URL: `https://tsw-lawyer-accountant.reynaldodallin.workers.dev`

Pages URL: `https://template-lawyer-accountant.pages.dev`

---

## 8. Validation gates

```bash
# No duplicate data-editable keys
grep -oE 'data-editable="[^"]*"' src/index.html | sort | uniq -d

# Total count between 40 and 200
grep -c 'data-editable' src/index.html

# No data-editable on forbidden containers
grep -E 'data-editable' src/index.html | grep -E '(<section|<div|<article|<header|<footer|<svg|<main|<aside|<nav)'
```

Each command above must return either zero lines (gates 1 and 3) or a number within range (gate 2).
