#!/usr/bin/env node
/**
 * TechSites Master Template — Build Script
 *
 * Zero external npm dependencies. Node >= 18 only.
 *
 * Steps:
 *   1. Load config.json (local) OR fetch from CLIENT_JSON_URL env if present
 *   2. Recursively copy src/ -> dist/
 *   3. Replace every {{dot.path}} placeholder in *.html, *.css, *.js, *.json,
 *      *.svg, *.txt, *.md output files with the corresponding value from the
 *      config object. Missing keys become empty string and are logged.
 *   4. Inline-render repeatable components (item-card.html, feature-card.html)
 *      via comment markers:
 *         <!-- repeat:items src/item-card.html -->
 *         <!-- repeat:features src/feature-card.html -->
 *      Each iteration gets {{item.foo}} or {{feature.foo}} resolution.
 *
 * Usage:
 *   node build.js
 *
 * Output:
 *   dist/  ready to be served by Cloudflare Pages (destination_dir = dist)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, "src");
const DIST_DIR = path.join(ROOT, "dist");
const CONFIG_PATH = path.join(ROOT, "config.json");

const TEXT_EXTS = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md", ".xml", ".webmanifest"]);

const REPEAT_MARK_RE = /<!--\s*repeat:([a-zA-Z0-9_]+)\s+([^\s>]+)\s*-->/g;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.\[\]-]+)\s*\}\}/g;

function log(msg) { console.log(`[build] ${msg}`); }
function warn(msg) { console.warn(`[build][warn] ${msg}`); }

async function loadConfig() {
  const remote = process.env.CLIENT_JSON_URL;
  if (remote && remote.trim()) {
    log(`fetching remote config: ${remote}`);
    const res = await fetch(remote, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`remote config HTTP ${res.status}`);
    return await res.json();
  }
  log(`loading local config: ${CONFIG_PATH}`);
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

function getPath(obj, dotted) {
  if (!obj) return undefined;
  const parts = dotted.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const m = part.match(/^([a-zA-Z0-9_-]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    cur = cur[m[1]];
    if (m[2] != null) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(m[2])];
    }
  }
  return cur;
}

function renderPlaceholders(text, ctx, missingKeys) {
  return text.replace(PLACEHOLDER_RE, (full, key) => {
    const value = getPath(ctx, key);
    if (value == null) {
      missingKeys.add(key);
      return "";
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function readTemplate(relPath) {
  const abs = path.join(ROOT, relPath);
  return fs.readFileSync(abs, "utf8");
}

function expandRepeats(html, config, missingKeys) {
  return html.replace(REPEAT_MARK_RE, (full, listKey, templateRel) => {
    const list = getPath(config, listKey);
    if (!Array.isArray(list)) {
      warn(`repeat block "${listKey}" is not an array`);
      return "";
    }
    const tpl = readTemplate(templateRel);
    const singular = listKey.endsWith("s") ? listKey.slice(0, -1) : listKey;
    return list.map((entry, index) => {
      const localCtx = Object.assign({}, config, {
        [singular]: entry,
        item: entry,
        feature: entry,
        entry: entry,
        index: index,
        position: index + 1
      });
      return renderPlaceholders(tpl, localCtx, missingKeys);
    }).join("\n");
  });
}

function copyAndRender(srcDir, distDir, config, missingKeys) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const distPath = path.join(distDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(distPath, { recursive: true });
      copyAndRender(srcPath, distPath, config, missingKeys);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    // Skip component partials — they are rendered inline via repeat markers.
    if (entry.name === "item-card.html" || entry.name === "feature-card.html") continue;
    if (TEXT_EXTS.has(ext)) {
      let text = fs.readFileSync(srcPath, "utf8");
      text = expandRepeats(text, config, missingKeys);
      text = renderPlaceholders(text, config, missingKeys);
      fs.writeFileSync(distPath, text, "utf8");
    } else {
      fs.copyFileSync(srcPath, distPath);
    }
  }
}

(async function main() {
  const startedAt = Date.now();
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`[build][error] src/ not found at ${SRC_DIR}`);
    process.exit(1);
  }
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const config = await loadConfig();

  // Copy assets/ (top-level, e.g. wysiwyg config + plugin) into dist/assets
  const topAssets = path.join(ROOT, "assets");
  if (fs.existsSync(topAssets)) {
    const distAssets = path.join(DIST_DIR, "assets");
    fs.mkdirSync(distAssets, { recursive: true });
    copyAndRender(topAssets, distAssets, config, new Set());
  }

  const missingKeys = new Set();
  copyAndRender(SRC_DIR, DIST_DIR, config, missingKeys);

  if (missingKeys.size) {
    warn(`missing placeholder keys (${missingKeys.size}): ${Array.from(missingKeys).slice(0, 20).join(", ")}${missingKeys.size > 20 ? " …" : ""}`);
  }
  log(`done in ${Date.now() - startedAt}ms → ${path.relative(ROOT, DIST_DIR)}/`);
})().catch((err) => {
  console.error("[build][fatal]", err && err.stack || err);
  process.exit(1);
});
