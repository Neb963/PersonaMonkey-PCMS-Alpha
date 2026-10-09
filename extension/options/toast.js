let hideTimer = null;
let boundNode = null;

function toastNode() {
  return document.getElementById("toast");
}

function bindDismiss(node) {
  if (!node || boundNode === node) return;
  node.addEventListener("click", () => clearToast());
  node.title = "Click to dismiss";
  boundNode = node;
}

export function toast(text, error = false, durationMs = null) {
  const node = toastNode();
  if (!node) return;
  bindDismiss(node);
  clearTimeout(hideTimer);
  hideTimer = null;
  const message = String(text ?? "").trim();
  if (!message) {
    clearToast();
    return;
  }

  // Temporarily disable announcements so repeated identical messages are
  // announced again when their text is restored.
  node.setAttribute("aria-live", "off");
  node.textContent = "";
  void node.offsetWidth;
  node.setAttribute("role", error ? "alert" : "status");
  node.setAttribute("aria-live", error ? "assertive" : "polite");
  node.setAttribute("aria-atomic", "true");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;

  const requested = durationMs == null ? (error ? 6500 : 4000) : Number(durationMs);
  const duration = Number.isFinite(requested) ? Math.max(0, requested) : (error ? 6500 : 4000);
  hideTimer = setTimeout(() => {
    node.className = "toast";
    node.textContent = "";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    hideTimer = null;
  }, duration);
}

export function clearToast() {
  clearTimeout(hideTimer);
  hideTimer = null;
  const node = toastNode();
  if (!node) return;
  node.textContent = "";
  node.className = "toast";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
}
