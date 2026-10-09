import { confirmAction } from "./confirm-dialog.js";

function valueText(value) {
  if (value && typeof value === "object" && "scheme" in value) {
    return `${value.scheme}://${value.host}:${value.port}`;
  }
  return JSON.stringify(value);
}

const AUTHORITY_LABELS = Object.freeze({
  "external-automation-authority-enabled": "Grant trusted callers permission to run external automations and control Personas",
  "executable-install-authority-enabled": "Grant trusted callers permission to install executable userscript code"
});

export function securityDeltaLine({ kind, path, before, after }) {
  const authority = AUTHORITY_LABELS[kind];
  const change = `${path}: ${valueText(before)} → ${valueText(after)}`;
  return authority ? `• ${authority} (${change})` : `• ${change}`;
}

export async function reviewSecurityDelta(delta, label = "state change") {
  if (!Array.isArray(delta) || !delta.length) return true;
  const lines = delta.map(securityDeltaLine);
  return confirmAction(
    `Approve these exact security changes from ${label}?\n\n${lines.join("\n")}`,
    { title: "Review security changes", confirmLabel: "Approve changes", danger: true }
  );
}

export async function authorizeSecurityPreview(preview, label) {
  if (!await reviewSecurityDelta(preview.delta, label)) return null;
  if (!preview.delta.length) return preview.previewId;
  const approved = await browser.runtime.sendMessage({
    type: "AUTHORIZE_SECURITY_PREVIEW", previewId: preview.previewId, approvedDelta: preview.delta
  });
  return approved.authorizationId;
}
