/**
 * TechSites Master Template — Lawyer & Accountant
 * WYSIWYG v1.1.1 client config (rendered by build.js).
 *
 * Values are sourced from config.json → wysiwyg.* and brand.*
 * The workerUrl placeholder will be filled after Worker deploy in ETAPA 6.
 */
window.TSW_CONFIG = {
  siteId: "{{wysiwyg.site_id}}",
  workerUrl: "{{wysiwyg.worker_url}}",
  password: "{{wysiwyg.password}}",
  allowedPages: ["index.html"],
  attribute: "data-editable",
  activation: {
    queryFlag: "tsw_edit",
    queryValue: "1",
    showGear: true,
    autoOpen: true
  },
  refresh: {
    enabled: true,
    seconds: 45,
    showTimeline: true,
    showChecklist: true
  },
  ui: {
    zIndex: 2147483000,
    accent: "{{brand.primary_color}}",
    accent2: "{{brand.accent_color}}"
  },
  backup: {
    github: { enabled: false, owner: "reynaldodallin", repo: "template-lawyer-accountant", branch: "main", note: "" },
    drive:  { enabled: false, folderId: "", note: "" }
  },
  hooks: {
    beforeSave: null,
    afterSave: null,
    onError: null
  }
};
