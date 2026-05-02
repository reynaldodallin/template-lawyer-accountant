/**
 * TSW Standalone — Worker isolado por site (Lawyer & Accountant master template).
 *
 * KV binding obrigatório: TSW_KV
 * Endpoints:
 *   - GET  /health
 *   - GET  /api/load?site_id=<id>&page_path=<path>
 *   - POST /api/save  { site_id, page_path, fields, url? }
 *   - OPTIONS /api/save  (CORS preflight)
 */

const VERSION = "1.0.0";

// === Per-site config ===================================================
const SITE_ID = "lawyer-accountant-master";
const ALLOWED_ORIGINS = [
  "https://template-lawyer-accountant.pages.dev",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];
// Cloudflare Pages preview subdomains: <hash>.template-lawyer-accountant.pages.dev
const ALLOWED_ORIGIN_REGEX = /^https:\/\/[a-z0-9-]+\.template-lawyer-accountant\.pages\.dev$/i;
const ALLOWED_PAGES = new Set(["index.html"]);
// =======================================================================

const EDITABLE_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,120}$/i;
const MAX_FIELDS = 700;
const MAX_VALUE_LENGTH = 12000;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_REGEX.test(origin);
}

function corsHeaders(origin) {
  const allowOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function normalizePagePath(value) {
  const raw = String(value || "index.html").trim();
  if (!raw || raw === "/" || raw === "index") return "index.html";
  const clean = raw
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "");
  const withExtension = clean.endsWith(".html") ? clean : `${clean}.html`;
  if (!/^[a-z0-9][a-z0-9_\-\/]*\.html$/i.test(withExtension)) return null;
  return ALLOWED_PAGES.has(withExtension) ? withExtension : null;
}

function validateFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return { ok: false, message: "fields must be an object" };
  }
  const entries = Object.entries(fields);
  if (entries.length > MAX_FIELDS) {
    return { ok: false, message: `too many fields; max ${MAX_FIELDS}` };
  }
  const safe = {};
  for (const [key, value] of entries) {
    if (!EDITABLE_KEY_RE.test(key)) {
      return { ok: false, message: `invalid editable key: ${key}` };
    }
    const text = String(value ?? "");
    if (text.length > MAX_VALUE_LENGTH) {
      return { ok: false, message: `field too long: ${key}` };
    }
    safe[key] = text;
  }
  return { ok: true, fields: safe };
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        status: "ok",
        service: "TSW Standalone Worker",
        version: VERSION,
        site_id: SITE_ID,
        allowed_pages: Array.from(ALLOWED_PAGES)
      }, 200, origin);
    }

    if (!env.TSW_KV) {
      return json({ success: false, message: "KV binding TSW_KV not configured" }, 500, origin);
    }

    if (url.pathname === "/api/load" && request.method === "GET") {
      const siteId = url.searchParams.get("site_id");
      const pagePath = normalizePagePath(url.searchParams.get("page_path"));
      if (siteId !== SITE_ID) {
        return json({ success: false, message: "invalid site_id for this isolated Worker" }, 403, origin);
      }
      if (!pagePath) {
        return json({ success: false, message: "page_path not allowed" }, 400, origin);
      }
      const key = `${SITE_ID}:${pagePath}`;
      const data = await env.TSW_KV.get(key, "json");
      return json({
        success: true,
        site_id: SITE_ID,
        page_path: pagePath,
        fields: data?.fields || {},
        saved_at: data?.saved_at || null,
        revision: data?.revision || null
      }, 200, origin);
    }

    if (url.pathname === "/api/save" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, message: "invalid JSON body" }, 400, origin);
      }
      const siteId = body.site_id;
      const pagePath = normalizePagePath(body.page_path);
      if (siteId !== SITE_ID) {
        return json({ success: false, message: `this Worker only accepts site_id ${SITE_ID}` }, 403, origin);
      }
      if (!pagePath) {
        return json({ success: false, message: "page_path not allowed" }, 400, origin);
      }
      const validated = validateFields(body.fields);
      if (!validated.ok) {
        return json({ success: false, message: validated.message }, 400, origin);
      }
      const savedAt = new Date().toISOString();
      const revision = await sha256(JSON.stringify({ siteId, pagePath, fields: validated.fields, savedAt }));
      const record = {
        site_id: SITE_ID,
        page_path: pagePath,
        fields: validated.fields,
        saved_at: savedAt,
        revision,
        source_url: String(body.url || "")
      };
      await env.TSW_KV.put(`${SITE_ID}:${pagePath}`, JSON.stringify(record));
      return json({
        success: true,
        site_id: SITE_ID,
        page_path: pagePath,
        saved_at: savedAt,
        revision,
        message: `Saved ${pagePath} to isolated KV.`
      }, 200, origin);
    }

    return json({ success: false, message: "not found" }, 404, origin);
  }
};
