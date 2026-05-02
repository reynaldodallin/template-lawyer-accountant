/*!
 * TechSites WYSIWYG Standalone — v1.1.1 (dentist review patch)
 * Plug-and-play inline editor for static multipage sites.
 *
 * v1.1.1 (review-only) — fixes refresh/finalize flow in the dentist review
 * environment: configurable 45s countdown, clean teardown of editor/overlay
 * before reload, hash-preserving URL cleanup, and a belt-and-suspenders
 * forced reload so the checklist box never gets stuck on the page.
 *
 * DESIGN GOALS
 * ------------
 * - Zero interference with the host site: no changes to CSS, no data-theme
 *   mutations, no classes on <html>/<body>, no localStorage for host theme.
 * - All UI lives in a Shadow DOM root mounted on a <tsw-root> host element.
 *   Only the host element touches the page; everything else is scoped.
 * - Dormant by default. Activation requires either the query flag
 *   ?tsw_edit=1 or an explicit click on a floating gear (also opt-in).
 * - Save/load against a per-site isolated Worker (POST /api/save,
 *   GET /api/load) using a configurable origin. No hardcoded endpoints.
 * - Optional post-save refresh flow with a visual timeline, checklist, and
 *   countdown — all scoped under Shadow DOM.
 * - Triple-backup (Worker/KV, GitHub, Drive) is left as documented
 *   interfaces only — this file DOES NOT make calls to GitHub or Drive.
 *
 * PUBLIC API
 * ----------
 *   TSWStandalone.init({ ...config })     // starts the editor dormant
 *   TSWStandalone.activate()               // open login overlay
 *   TSWStandalone.deactivate()             // turn off edit mode, keep loaded values
 *   TSWStandalone.save()                   // programmatic save (no UI)
 *   TSWStandalone.version                  // "1.0.0"
 *
 * Config shape: see assets/js/techsites-wysiwyg.config.example.js.
 */
(function () {
  "use strict";

  var VERSION = "1.1.1";
  var ROOT_TAG = "tsw-root";
  var STATE = {
    config: null,
    host: null,
    shadow: null,
    editing: false,
    lastSavedAt: null,
    lastRevision: null,
    loadedFields: {},
    refreshTimer: null
  };

  // ---------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------
  var DEFAULTS = Object.freeze({
    siteId: null,                       // REQUIRED, e.g. "mysite-preview"
    workerUrl: null,                    // REQUIRED, e.g. "https://my-worker.workers.dev"
    password: null,                     // REQUIRED, shared secret (client-side gate only)
    allowedPages: null,                 // optional array; if null, editor accepts any *.html from location
    attribute: "data-editable",         // attribute used to mark editable nodes
    activation: {
      queryFlag: "tsw_edit",            // ?tsw_edit=1 auto-opens login
      queryValue: "1",
      showGear: true                    // fallback floating button (opt-in)
    },
    refresh: {
      enabled: false,                   // optional post-save refresh flow
      seconds: 5,
      showTimeline: true,
      showChecklist: true
    },
    ui: {
      zIndex: 2147483000,
      accent: "#22d3ee",
      accent2: "#7c3aed"
    },
    backup: {                           // DOCUMENTATION-ONLY in v1
      github: { enabled: false, note: "interface only — not implemented" },
      drive:  { enabled: false, note: "interface only — not implemented" }
    },
    hooks: {
      beforeSave: null,                 // (fields) => fields | Promise<fields>
      afterSave: null,                  // (result) => void
      onError: null                     // (err, phase) => void
    }
  });

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function deepFreeze(obj) {
    if (obj && typeof obj === "object") {
      Object.values(obj).forEach(deepFreeze);
      Object.freeze(obj);
    }
    return obj;
  }

  function mergeConfig(user) {
    var cfg = JSON.parse(JSON.stringify(DEFAULTS));
    if (!user || typeof user !== "object") return cfg;
    function merge(target, src) {
      Object.keys(src).forEach(function (k) {
        if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
          target[k] = target[k] || {};
          merge(target[k], src[k]);
        } else {
          target[k] = src[k];
        }
      });
    }
    merge(cfg, user);
    // Preserve hook functions (JSON.stringify dropped them)
    if (user.hooks) {
      cfg.hooks = cfg.hooks || {};
      ["beforeSave", "afterSave", "onError"].forEach(function (k) {
        if (typeof user.hooks[k] === "function") cfg.hooks[k] = user.hooks[k];
      });
    }
    return cfg;
  }

  function validateConfig(cfg) {
    var missing = [];
    if (!cfg.siteId) missing.push("siteId");
    if (!cfg.workerUrl) missing.push("workerUrl");
    if (!cfg.password) missing.push("password");
    if (missing.length) {
      throw new Error("[tsw-standalone] missing required config: " + missing.join(", "));
    }
    try {
      var u = new URL(cfg.workerUrl);
      if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
        throw new Error("workerUrl must be https:// (or localhost for dev)");
      }
    } catch (e) {
      throw new Error("[tsw-standalone] invalid workerUrl: " + e.message);
    }
  }

  function normalizePagePath(pathname, allowedPages) {
    var last = (pathname || "/").split("/").pop();
    if (!last) last = "index.html";
    if (!/\.html$/i.test(last)) last = last + ".html";
    if (!/^[a-z0-9][a-z0-9_-]*\.html$/i.test(last)) return null;
    if (Array.isArray(allowedPages) && allowedPages.length) {
      if (allowedPages.indexOf(last) === -1) return null;
    }
    return last;
  }

  function log(msg) {
    if (typeof console !== "undefined" && console.info) {
      console.info("[tsw-standalone] " + msg);
    }
  }

  function warn(msg) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[tsw-standalone] " + msg);
    }
  }

  // ---------------------------------------------------------------------
  // Shadow DOM styles (all prefixed tsw- or scoped inside shadow)
  // ---------------------------------------------------------------------
  function shadowStyles(cfg) {
    return [
      ":host { all: initial; position: fixed; pointer-events: auto; z-index: " + cfg.ui.zIndex + "; }",
      ".tsw-layer { position: fixed; inset: 0; pointer-events: none; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }",
      ".tsw-gear { position: fixed; right: 18px; bottom: 18px; width: 44px; height: 44px; border-radius: 999px; border: 1px solid rgba(255,255,255,.2); background: linear-gradient(135deg, " + cfg.ui.accent + ", " + cfg.ui.accent2 + "); color: #02111d; font-weight: 900; cursor: pointer; pointer-events: auto; box-shadow: 0 8px 24px rgba(0,0,0,.35); }",
      ".tsw-login { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgba(2,6,23,.72); backdrop-filter: blur(16px); pointer-events: auto; }",
      ".tsw-login__card { display: block; box-sizing: border-box; width: min(440px, calc(100vw - 32px)); min-height: 0; border: 1px solid rgba(255,255,255,.14); border-radius: 26px; background: #07111f; color: #f8fafc; box-shadow: 0 24px 70px rgba(0,0,0,.48); padding: 28px; position: relative; z-index: 1; font-family: Inter, system-ui, sans-serif; }",
      ".tsw-login__card * { box-sizing: border-box; }",
      ".tsw-login__card h2 { margin: 0 0 8px; font: 800 20px/1.25 Inter, system-ui, sans-serif; }",
      ".tsw-login__card p { margin: 0 0 12px; font: 400 14px/1.6 Inter, system-ui, sans-serif; color: #94a3b8; }",
      ".tsw-login__card code { color: " + cfg.ui.accent + "; background: rgba(34,211,238,.08); padding: 1px 6px; border-radius: 4px; }",
      ".tsw-login__card input { box-sizing: border-box; width: 100%; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; background: #020617; color: #f8fafc; padding: 14px 16px; margin: 12px 0; font: 400 14px/1 Inter, system-ui, sans-serif; outline: none; }",
      ".tsw-login__card input:focus { border-color: " + cfg.ui.accent + "; box-shadow: 0 0 0 4px rgba(34,211,238,.12); }",
      ".tsw-login__card button { width: 100%; border: 0; border-radius: 999px; padding: 12px 14px; background: linear-gradient(135deg, " + cfg.ui.accent + ", #2563eb 55%, " + cfg.ui.accent2 + "); color: #02111d; font: 800 14px/1 Inter, system-ui, sans-serif; cursor: pointer; }",
      /* Toolbar — coexists with site header; body gets padding-top so site header stays visible below. */
      ".tsw-toolbar { position: fixed; inset: 0 0 auto 0; z-index: 9999; min-height: 86px; box-sizing: border-box; display: flex; align-items: center; gap: 18px; width: 100vw; border-bottom: 1px solid rgba(148,163,184,.18); background: linear-gradient(180deg, rgba(6,12,32,.98), rgba(8,15,36,.96)); color: #f8fafc; padding: 14px max(28px, env(safe-area-inset-left)) 14px max(28px, env(safe-area-inset-right)); box-shadow: 0 18px 54px rgba(0,0,0,.34); backdrop-filter: blur(18px); font: 600 15px/1.2 Inter, system-ui, sans-serif; pointer-events: auto; }",
      ".tsw-toolbar__active { display: inline-flex; align-items: center; gap: 14px; min-width: max-content; }",
      ".tsw-toolbar__dot { width: 10px; height: 10px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 22px rgba(34,197,94,.8); }",
      ".tsw-toolbar__badge { display: inline-flex; align-items: center; min-height: 38px; padding: 0 18px; border-radius: 7px; border: 1px solid rgba(34,197,94,.32); background: rgba(34,197,94,.08); color: #86efac; font: 900 13px/1 Inter, system-ui, sans-serif; letter-spacing: .18em; text-transform: uppercase; }",
      ".tsw-toolbar__label { color: #cbd5e1; white-space: nowrap; font: 600 16px/1.2 Inter, system-ui, sans-serif; }",
      ".tsw-toolbar__spacer { flex: 1 1 auto; }",
      ".tsw-toolbar__status { color: #cbd5e1; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".tsw-toolbar button { min-height: 54px; padding: 0 26px; border-radius: 8px; font: 800 16px/1 Inter, system-ui, sans-serif; cursor: pointer; }",
      ".tsw-btn--save { border: 0; background: linear-gradient(135deg, #3b82f6, #4f46e5 55%, #7c3aed); color: #fff; box-shadow: 0 12px 36px rgba(79,70,229,.28); display: inline-flex; align-items: center; gap: 8px; }",
      ".tsw-btn--exit { border: 1px solid rgba(148,163,184,.28); background: rgba(2,6,23,.32); color: #dbeafe; display: inline-flex; align-items: center; gap: 8px; }",
      ".tsw-btn__icon { width: 18px; height: 18px; display: inline-block; flex: 0 0 auto; }",
      /* ---------- Mobile responsiveness ---------- */
      /* Portrait phones: collapse label/status + exit-on-topbar; keep badge + save. */
      "@media (max-width: 760px) and (orientation: portrait) {",
      "  .tsw-toolbar { min-height: 74px; gap: 12px; padding: 10px 14px; }",
      "  .tsw-toolbar__label, .tsw-toolbar__status, .tsw-btn--exit { display: none; }",
      "  .tsw-toolbar__badge { min-height: 38px; padding: 0 14px; font-size: 12px; }",
      "  .tsw-toolbar button { min-height: 48px; padding: 0 18px; font-size: 14px; }",
      "}",
      /* Landscape phones: show Exit + Save, hide 'editable fields' label and status. */
      "@media (max-width: 900px) and (orientation: landscape) {",
      "  .tsw-toolbar { min-height: 64px; gap: 10px; padding: 8px 14px; }",
      "  .tsw-toolbar__label, .tsw-toolbar__status { display: none; }",
      "  .tsw-toolbar__badge { min-height: 34px; padding: 0 12px; font-size: 11px; letter-spacing: .14em; }",
      "  .tsw-toolbar button { min-height: 42px; padding: 0 14px; font-size: 13px; }",
      "  .tsw-btn__icon { width: 15px; height: 15px; }",
      "}",
      /* ---------- Publishing overlay (centered dark card with lightning icon) ---------- */
      ".tsw-pub { position: fixed; inset: 0; z-index: 10001; display: grid; place-items: center; background: radial-gradient(ellipse at center, rgba(2,6,23,.86), rgba(2,6,23,.94)); backdrop-filter: blur(14px); pointer-events: auto; font-family: Inter, system-ui, sans-serif; }",
      ".tsw-pub__card { width: min(440px, calc(100vw - 32px)); box-sizing: border-box; background: #0b1426; color: #e2e8f0; border: 1px solid rgba(71,85,105,.38); border-radius: 22px; padding: 36px 30px 30px; box-shadow: 0 30px 80px rgba(0,0,0,.55); text-align: center; }",
      ".tsw-pub__bolt { width: 72px; height: 72px; margin: 0 auto 22px; border-radius: 999px; display: grid; place-items: center; background: radial-gradient(circle at 30% 25%, #6d7dff, #3b4bff 60%, #1e2a8a); box-shadow: 0 14px 40px rgba(91,107,255,.55), 0 0 0 10px rgba(91,107,255,.08); }",
      ".tsw-pub__bolt svg { width: 34px; height: 34px; color: #fff; display: block; }",
      ".tsw-pub__title { margin: 0 0 10px; font: 700 22px/1.25 Inter, system-ui, sans-serif; color: #f8fafc; }",
      ".tsw-pub__lede { margin: 0 0 22px; font: 400 14px/1.5 Inter, system-ui, sans-serif; color: #94a3b8; }",
      ".tsw-pub__bar { position: relative; width: 100%; height: 6px; background: rgba(148,163,184,.18); border-radius: 999px; overflow: hidden; margin-bottom: 18px; }",
      ".tsw-pub__bar i { position: absolute; inset: 0 auto 0 0; width: 0%; background: linear-gradient(90deg, #3b82f6 0%, #6366f1 50%, #22c55e 100%); border-radius: 999px; transition: width .85s ease; }",
      ".tsw-pub__count { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin: 4px 0 22px; }",
      ".tsw-pub__count b { font: 800 44px/1 Inter, system-ui, sans-serif; color: #3b82f6; letter-spacing: -.02em; }",
      ".tsw-pub__count span { font: 500 15px/1 Inter, system-ui, sans-serif; color: #94a3b8; }",
      ".tsw-pub__list { list-style: none; padding: 0; margin: 14px 0 0; text-align: left; }",
      ".tsw-pub__list li { display: flex; align-items: center; gap: 12px; padding: 7px 0; font: 500 14px/1.2 Inter, system-ui, sans-serif; color: #64748b; transition: color .25s ease; }",
      ".tsw-pub__list li .tsw-pub__dot { width: 16px; height: 16px; border-radius: 999px; background: rgba(100,116,139,.22); flex: 0 0 auto; display: grid; place-items: center; }",
      ".tsw-pub__list li.is-active { color: #e2e8f0; }",
      ".tsw-pub__list li.is-active .tsw-pub__dot { background: transparent; border: 2px solid #3b82f6; animation: tsw-spin 1.1s linear infinite; border-top-color: transparent; border-right-color: transparent; }",
      ".tsw-pub__list li.is-done { color: #cbd5e1; }",
      ".tsw-pub__list li.is-done .tsw-pub__dot { background: #22c55e; }",
      ".tsw-pub__list li.is-done .tsw-pub__dot::after { content: ''; display: block; width: 6px; height: 3px; border-left: 2px solid #0b1426; border-bottom: 2px solid #0b1426; transform: translate(0,-1px) rotate(-45deg); }",
      ".tsw-pub__hint { margin: 22px 0 0; font: 400 13px/1.45 Inter, system-ui, sans-serif; color: #64748b; text-align: center; }",
      "@keyframes tsw-spin { to { transform: rotate(360deg); } }",
      /* Legacy refresh (kept for compat if anyone calls it) */
      ".tsw-refresh { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(2,6,23,.82); pointer-events: auto; }",
      ".tsw-edit-highlight { outline: 2px solid " + cfg.ui.accent + " !important; outline-offset: 4px !important; border-radius: 8px; }"
    ].join("\n");
  }

  // ---------------------------------------------------------------------
  // Shadow DOM boot
  // ---------------------------------------------------------------------
  function ensureHost(cfg) {
    if (STATE.host && document.body.contains(STATE.host)) return;
    var host = document.createElement(ROOT_TAG);
    host.setAttribute("data-tsw-version", VERSION);
    document.body.appendChild(host);
    STATE.host = host;
    setHostFrame("gear");
    var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : null;
    if (!shadow) {
      warn("Shadow DOM not supported; editor will not render to avoid touching host CSS");
      return;
    }
    var style = document.createElement("style");
    style.textContent = shadowStyles(cfg);
    shadow.appendChild(style);

    var layer = document.createElement("div");
    layer.className = "tsw-layer";
    shadow.appendChild(layer);

    STATE.shadow = shadow;
  }

  function setHostFrame(mode) {
    if (!STATE.host) return;
    var host = STATE.host;
    var zIndex = STATE.config && STATE.config.ui ? STATE.config.ui.zIndex : DEFAULTS.ui.zIndex;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = String(zIndex);
    host.style.pointerEvents = "auto";
    host.style.overflow = "visible";
    host.style.top = "auto";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = "auto";
    host.style.width = "auto";
    host.style.height = "auto";
    if (mode === "modal") {
      host.style.top = "0";
      host.style.right = "0";
      host.style.bottom = "0";
      host.style.left = "0";
      host.style.width = "100vw";
      host.style.height = "100vh";
      return;
    }
    if (mode === "toolbar") {
      host.style.top = "0";
      host.style.right = "0";
      host.style.left = "0";
      host.style.width = "100vw";
      host.style.height = toolbarHeight() + "px";
      return;
    }
    host.style.right = "0";
    host.style.bottom = "0";
    host.style.width = "88px";
    host.style.height = "88px";
  }

  function shadowEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function layer() {
    return STATE.shadow && STATE.shadow.querySelector(".tsw-layer");
  }

  function clearLayer() {
    var l = layer();
    if (l) l.innerHTML = "";
  }

  // ---------------------------------------------------------------------
  // Gear + login
  // ---------------------------------------------------------------------
  function renderGear() {
    if (!STATE.config.activation.showGear) return;
    if (!layer()) return;
    if (STATE.shadow.querySelector(".tsw-gear")) return;
    var btn = shadowEl("button", "tsw-gear", "\u270E");
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-label", "Open TechSites editor");
    btn.addEventListener("click", showLogin);
    layer().appendChild(btn);
  }

  function showLogin() {
    if (!layer()) return;
    if (STATE.shadow.querySelector(".tsw-login")) return;
    setHostFrame("modal");
    var wrap = shadowEl("div", "tsw-login");
    var card = shadowEl("form", "tsw-login__card");
    card.appendChild(shadowEl("h2", null, "TechSites WYSIWYG"));
    var p = shadowEl("p"); p.innerHTML = "Standalone editor for <code>" + escapeHtml(STATE.config.siteId) + "</code>. Nothing in the host page is modified until you save.";
    card.appendChild(p);
    var input = document.createElement("input");
    input.type = "password";
    input.placeholder = "Password";
    input.autocomplete = "current-password";
    card.appendChild(input);
    var submit = shadowEl("button", null, "Enable editor");
    submit.type = "submit";
    card.appendChild(submit);
    wrap.appendChild(card);
    card.addEventListener("submit", function (e) {
      e.preventDefault();
      if (input.value !== STATE.config.password) {
        input.value = ""; input.placeholder = "Wrong password";
        return;
      }
      wrap.remove();
      enableEditing();
    });
    wrap.addEventListener("click", function (e) { if (e.target === wrap) { wrap.remove(); setHostFrame("gear"); } });
    layer().appendChild(wrap);
    input.focus();
  }

  // ---------------------------------------------------------------------
  // Editing mode
  // ---------------------------------------------------------------------
  function editableNodes() {
    var attr = STATE.config.attribute;
    return Array.prototype.slice.call(document.querySelectorAll("[" + attr + "]"));
  }

  function enableEditing() {
    if (STATE.editing) return;
    STATE.editing = true;
    setHostFrame("toolbar");
    applyEditorOffset();
    editableNodes().forEach(function (n) {
      n.setAttribute("contenteditable", "true");
      n.setAttribute("spellcheck", "true");
      n.classList.add("tsw-edit-highlight");
    });
    renderToolbar();
  }

  function disableEditing() {
    STATE.editing = false;
    setHostFrame("gear");
    removeEditorOffset();
    editableNodes().forEach(function (n) {
      n.removeAttribute("contenteditable");
      n.removeAttribute("spellcheck");
      n.classList.remove("tsw-edit-highlight");
    });
    var t = STATE.shadow && STATE.shadow.querySelector(".tsw-toolbar");
    if (t) t.remove();
  }

  function svgIcon(kind) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("class", "tsw-btn__icon");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(ns, "path");
    if (kind === "exit") {
      path.setAttribute("d", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9");
    } else if (kind === "save") {
      // Floppy disk
      path.setAttribute("d", "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8");
    }
    svg.appendChild(path);
    return svg;
  }

  function renderToolbar() {
    if (!layer()) return;
    var old = STATE.shadow.querySelector(".tsw-toolbar");
    if (old) old.remove();
    var bar = shadowEl("div", "tsw-toolbar");
    var active = shadowEl("div", "tsw-toolbar__active");
    active.appendChild(shadowEl("span", "tsw-toolbar__dot"));
    active.appendChild(shadowEl("span", "tsw-toolbar__badge", "Editor Active"));
    bar.appendChild(active);
    bar.appendChild(shadowEl("span", "tsw-toolbar__label", editableNodes().length + " editable fields"));
    var status = shadowEl("span", "tsw-toolbar__status", STATE.lastSavedAt ? ("Last save: " + STATE.lastSavedAt) : "Ready");
    bar.appendChild(status);
    bar.appendChild(shadowEl("span", "tsw-toolbar__spacer"));
    var exit = shadowEl("button", "tsw-btn--exit");
    exit.type = "button";
    exit.appendChild(svgIcon("exit"));
    exit.appendChild(shadowEl("span", null, "Exit without saving"));
    exit.addEventListener("click", function () { disableEditing(); });
    var save = shadowEl("button", "tsw-btn--save");
    save.type = "button";
    save.appendChild(svgIcon("save"));
    save.appendChild(shadowEl("span", null, "Save & Publish"));
    save.addEventListener("click", function () { doSave(status); });
    bar.appendChild(exit);
    bar.appendChild(save);
    layer().appendChild(bar);
  }

  function toolbarHeight() {
    if (!window.matchMedia) return 86;
    // Landscape phones: slimmer bar (64px). Portrait phones: 74px. Desktop/tablet: 86px.
    if (window.matchMedia("(max-width: 900px) and (orientation: landscape)").matches) return 64;
    if (window.matchMedia("(max-width: 760px) and (orientation: portrait)").matches) return 74;
    if (window.matchMedia("(max-width: 760px)").matches) return 74;
    return 86;
  }

  function applyEditorOffset() {
    var h = toolbarHeight();
    document.documentElement.style.setProperty("--tsw-editor-offset", h + "px");
    document.documentElement.classList.add("tsw-editor-active-offset");
    if (!document.getElementById("tsw-offset-style")) {
      var style = document.createElement("style");
      style.id = "tsw-offset-style";
      // Push body down by topbar height AND push any sticky site header down so menu/brand remain visible.
      // We keep the host site's header position: sticky behavior — just shift it by the editor offset.
      style.textContent = [
        "html.tsw-editor-active-offset body{padding-top:var(--tsw-editor-offset)!important;transition:padding-top .24s ease;}",
        "html.tsw-editor-active-offset{scroll-padding-top:var(--tsw-editor-offset)!important;}",
        /* Common sticky-header selectors used by TechSites templates */
        "html.tsw-editor-active-offset .header,html.tsw-editor-active-offset header.header,html.tsw-editor-active-offset header[role='banner'],html.tsw-editor-active-offset .site-header,html.tsw-editor-active-offset .nav-bar{top:var(--tsw-editor-offset)!important;}"
      ].join("");
      document.head.appendChild(style);
    }
    // Re-apply on orientation/resize (portrait<->landscape changes toolbar height).
    if (!STATE._resizeHandler) {
      STATE._resizeHandler = function () {
        if (!STATE.editing) return;
        var nh = toolbarHeight();
        document.documentElement.style.setProperty("--tsw-editor-offset", nh + "px");
        setHostFrame("toolbar");
      };
      window.addEventListener("resize", STATE._resizeHandler);
      window.addEventListener("orientationchange", STATE._resizeHandler);
    }
  }

  function removeEditorOffset() {
    document.documentElement.classList.remove("tsw-editor-active-offset");
    document.documentElement.style.removeProperty("--tsw-editor-offset");
  }

  // ---------------------------------------------------------------------
  // Save / Load
  // ---------------------------------------------------------------------
  function collectFields() {
    var fields = {};
    editableNodes().forEach(function (n) {
      var key = n.getAttribute(STATE.config.attribute);
      if (!key) return;
      fields[key] = sanitizeInlineHtml(n.innerHTML || "");
    });
    return fields;
  }

  async function doSave(statusEl) {
    var cfg = STATE.config;
    var page = normalizePagePath(location.pathname, cfg.allowedPages);
    if (!page) {
      setStatus(statusEl, "Error: page_path not allowed");
      return;
    }
    var fields = collectFields();
    if (typeof cfg.hooks.beforeSave === "function") {
      try { fields = await cfg.hooks.beforeSave(fields) || fields; } catch (e) { warn("beforeSave hook failed: " + e.message); }
    }
    setStatus(statusEl, "Saving...");
    try {
      var resp = await fetch(cfg.workerUrl.replace(/\/+$/, "") + "/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          site_id: cfg.siteId,
          page_path: page,
          fields: fields,
          url: location.href,
          timestamp: new Date().toISOString()
        })
      });
      var data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || ("HTTP " + resp.status));
      STATE.lastSavedAt = new Date().toLocaleTimeString();
      STATE.lastRevision = data.revision || null;
      setStatus(statusEl, "Saved " + STATE.lastSavedAt + (STATE.lastRevision ? (" · " + STATE.lastRevision.slice(0, 8)) : ""));
      if (typeof cfg.hooks.afterSave === "function") {
        try { cfg.hooks.afterSave(data); } catch (e) { /* ignore */ }
      }
      if (cfg.refresh && cfg.refresh.enabled) startRefreshFlow(data);
    } catch (err) {
      setStatus(statusEl, "Error: " + err.message);
      if (typeof cfg.hooks.onError === "function") {
        try { cfg.hooks.onError(err, "save"); } catch (e) {}
      }
    }
  }

  function setStatus(el, text) { if (el) el.textContent = text; }

  async function loadFields() {
    var cfg = STATE.config;
    var page = normalizePagePath(location.pathname, cfg.allowedPages);
    if (!page) return;
    try {
      var url = cfg.workerUrl.replace(/\/+$/, "") + "/api/load?site_id=" +
                encodeURIComponent(cfg.siteId) + "&page_path=" + encodeURIComponent(page);
      var resp = await fetch(url, { headers: { "Accept": "application/json" } });
      var data = await resp.json();
      if (!resp.ok || !data.success) return;
      STATE.loadedFields = data.fields || {};
      STATE.lastSavedAt = data.saved_at ? new Date(data.saved_at).toLocaleString() : null;
      STATE.lastRevision = data.revision || null;
      Object.keys(STATE.loadedFields).forEach(function (k) {
        var node = document.querySelector("[" + cfg.attribute + '="' + cssEscape(k) + '"]');
        if (node) node.innerHTML = sanitizeInlineHtml(STATE.loadedFields[k]);
      });
    } catch (err) {
      warn("load failed: " + err.message);
      if (typeof cfg.hooks.onError === "function") {
        try { cfg.hooks.onError(err, "load"); } catch (e) {}
      }
    }
  }

  function cssEscape(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function sanitizeInlineHtml(value) {
    var template = document.createElement("template");
    template.innerHTML = String(value == null ? "" : value).trim();
    var allowedTags = {
      BR: true,
      SPAN: true,
      STRONG: true,
      B: true,
      EM: true,
      I: true,
      SMALL: true,
      SUP: true,
      SUB: true
    };
    function clean(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 1) {
          if (!allowedTags[child.tagName]) {
            child.replaceWith(document.createTextNode(child.textContent || ""));
            return;
          }
          Array.prototype.slice.call(child.attributes).forEach(function (attr) {
            var name = attr.name.toLowerCase();
            if (name !== "class" && name !== "aria-hidden") child.removeAttribute(attr.name);
            if (name === "class" && !/^[a-zA-Z0-9_:\\-\\s]+$/.test(attr.value)) child.removeAttribute(attr.name);
          });
          clean(child);
        } else if (child.nodeType !== 3) {
          child.remove();
        }
      });
    }
    clean(template.content);
    return template.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Publishing overlay (matches approved visual spec)
  // Dark centered card — lightning bolt — blue→green progress bar —
  // countdown in seconds — 4-step checklist — auto reload.
  // ---------------------------------------------------------------------
  function startRefreshFlow(saveResult) {
    clearLayer();
    setHostFrame("modal");
    // Hide the toolbar visually (we replace with the overlay) but keep body offset
    // so the page doesn't jump during the countdown.
    var total = Math.max(3, Number(STATE.config.refresh.seconds) || 6);

    var wrap = shadowEl("div", "tsw-pub");
    var card = shadowEl("div", "tsw-pub__card");

    // Lightning bolt icon
    var bolt = shadowEl("div", "tsw-pub__bolt");
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M13 2 3 14h7l-1 8 10-12h-7l1-8z");
    svg.appendChild(path);
    bolt.appendChild(svg);
    card.appendChild(bolt);

    card.appendChild(shadowEl("h3", "tsw-pub__title", "Publishing Your Changes"));
    card.appendChild(shadowEl("p", "tsw-pub__lede", "Your updates are being deployed to the CDN \u2014 sit tight!"));

    // Progress bar (blue → green gradient)
    var bar = shadowEl("div", "tsw-pub__bar");
    var fill = shadowEl("i");
    bar.appendChild(fill);
    card.appendChild(bar);

    // Countdown
    var countWrap = shadowEl("div", "tsw-pub__count");
    var countNum = shadowEl("b", null, String(total));
    var countLbl = shadowEl("span", null, "seconds");
    countWrap.appendChild(countNum);
    countWrap.appendChild(countLbl);
    card.appendChild(countWrap);

    // Checklist (4 items, match approved copy)
    var steps = ["Saving content", "Deploying to CDN", "Refreshing cache", "Site is live"];
    var ul = shadowEl("ul", "tsw-pub__list");
    var liRefs = steps.map(function (label) {
      var li = shadowEl("li");
      li.appendChild(shadowEl("span", "tsw-pub__dot"));
      li.appendChild(shadowEl("span", null, label));
      ul.appendChild(li);
      return li;
    });
    card.appendChild(ul);

    card.appendChild(shadowEl("p", "tsw-pub__hint", "The page will reload automatically when ready."));

    wrap.appendChild(card);
    layer().appendChild(wrap);

    // Animate: tick checklist across the total window.
    var stepBoundaries = liRefs.map(function (_, i) {
      // Distribute steps evenly, last one completes right before reload.
      return Math.round(total * (i + 1) / liRefs.length);
    });
    // Mark step 0 active immediately
    liRefs[0].classList.add("is-active");

    // Kick progress bar animation on next frame so CSS transition engages.
    requestAnimationFrame(function () { fill.style.width = "100%"; fill.style.transitionDuration = total + "s"; });

    var elapsed = 0;
    STATE.refreshTimer = setInterval(function () {
      elapsed += 1;
      var left = Math.max(0, total - elapsed);
      countNum.textContent = String(left);
      // Advance checklist: any step whose boundary <= elapsed becomes done;
      // the next pending step becomes active.
      var nextActive = -1;
      liRefs.forEach(function (li, idx) {
        if (elapsed >= stepBoundaries[idx]) {
          li.classList.remove("is-active");
          li.classList.add("is-done");
        } else if (nextActive === -1) {
          nextActive = idx;
        }
      });
      if (nextActive !== -1) {
        liRefs.forEach(function (li, idx) {
          if (idx === nextActive) li.classList.add("is-active");
          else if (!li.classList.contains("is-done")) li.classList.remove("is-active");
        });
      }
      if (left <= 0) {
        clearInterval(STATE.refreshTimer);
        STATE.refreshTimer = null;
        // Ensure every step is visually marked done before we tear down the UI.
        liRefs.forEach(function (li) {
          li.classList.remove("is-active");
          li.classList.add("is-done");
        });
        // Tear down editor state + overlay BEFORE navigating so, even if the
        // browser hesitates on a same-document navigation, the user never sees
        // a stuck checklist box.
        try { disableEditing(); } catch (_) {}
        try { clearLayer(); } catch (_) {}
        try { setHostFrame("gear"); } catch (_) {}
        removeEditorOffset();
        // Build a clean URL: drop ?tsw_edit=1 (and any dangling query
        // separators) while preserving the hash so the user stays on the
        // section they were editing (e.g. #home, #services, #about).
        var cleanUrl = buildCleanUrl();
        // Use replace() so the dormant reload does not pollute history.
        // If the browser ever no-ops (same document, only query removed),
        // force a hard reload as a fallback.
        try {
          location.replace(cleanUrl);
        } catch (_) {
          location.href = cleanUrl;
        }
        // Belt-and-suspenders: if the navigation has not happened within
        // ~400ms (same-document hash preservation edge cases), force reload.
        setTimeout(function () {
          try { location.reload(); } catch (_) {}
        }, 400);
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------
  // HTML escape helper
  // ---------------------------------------------------------------------
  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------------------
  // Build a clean reload URL: strips the auto-activation query flag
  // (default: tsw_edit) while preserving the path and hash. Robust to
  // URLSearchParams being unavailable by falling back to manual string ops.
  // ---------------------------------------------------------------------
  function buildCleanUrl() {
    var flag = (STATE.config && STATE.config.activation && STATE.config.activation.queryFlag) || "tsw_edit";
    try {
      var u = new URL(location.href);
      u.searchParams.delete(flag);
      // If nothing is left in the query, strip the trailing "?" for a tidy URL.
      var qs = u.searchParams.toString();
      var base = u.origin + u.pathname + (qs ? ("?" + qs) : "");
      return base + (u.hash || "");
    } catch (_) {
      // Fallback string surgery for ancient browsers.
      var href = location.href;
      var hashIdx = href.indexOf("#");
      var hash = hashIdx >= 0 ? href.slice(hashIdx) : "";
      var noHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      var stripped = noHash.replace(new RegExp("([?&])" + flag + "=[^&]*", "g"), "$1")
                           .replace(/\?&/, "?")
                           .replace(/[?&]$/, "");
      return stripped + hash;
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function autoActivationRequested(cfg) {
    if (!cfg.activation) return false;
    // Respect explicit opt-out: autoOpen: false disables URL-based activation.
    if (cfg.activation.autoOpen === false) return false;
    try {
      var qs = new URLSearchParams(location.search);
      return qs.get(cfg.activation.queryFlag) === cfg.activation.queryValue;
    } catch (_) { return false; }
  }

  function init(userConfig) {
    var cfg = mergeConfig(userConfig);
    validateConfig(cfg);
    STATE.config = cfg;
    function boot() {
      ensureHost(cfg);
      if (!STATE.shadow) return; // Shadow DOM unsupported; stay dormant.
      renderGear();
      loadFields();
      if (autoActivationRequested(cfg)) showLogin();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
    log("initialized for site_id=" + cfg.siteId + " (dormant)");
  }

  // Expose the public API — no globals other than this single namespace.
  window.TSWStandalone = deepFreeze({
    version: VERSION,
    init: init,
    activate: function () { if (STATE.config) showLogin(); },
    deactivate: disableEditing,
    save: function () {
      if (!STATE.editing) enableEditing();
      doSave();
    }
  });
})();
