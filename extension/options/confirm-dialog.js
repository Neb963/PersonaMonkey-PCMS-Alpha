let activeRequest = null;

function restoreFocus(target) {
  if (target?.isConnected && typeof target.focus === "function") target.focus();
}

function settle(record, value, { restore = true } = {}) {
  if (!record || record.settled) return;
  record.settled = true;
  if (activeRequest === record) activeRequest = null;
  const resolve = record.resolve;
  record.resolve = null;
  record.dialog?.remove();
  resolve?.(Boolean(value));
  // Firefox may move focus back to the document body after the native dialog
  // close event has already fired. Restore on the next task so that native
  // dialog focus cleanup cannot overwrite the opener focus.
  if (restore) setTimeout(() => restoreFocus(record.opener), 0);
}

function cancelActive({ restore = false } = {}) {
  const record = activeRequest;
  if (!record) return;
  if (record.dialog?.open) {
    try { record.dialog.close("superseded"); } catch {}
  }
  settle(record, record.outcome ?? false, { restore });
}

function createDialog(record) {
  const dialog = document.createElement("dialog");
  dialog.className = "confirmation-dialog";

  const form = document.createElement("form");
  form.method = "dialog";

  const title = document.createElement("h3");
  title.textContent = "Confirm action";

  const message = document.createElement("p");
  message.className = "confirmation-dialog-message";

  const actions = document.createElement("div");
  actions.className = "confirmation-dialog-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.value = "cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    record.outcome = false;
    dialog.close("cancel");
  });

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.value = "confirm";
  confirm.className = "danger";
  confirm.textContent = "Confirm";
  confirm.addEventListener("click", () => {
    record.outcome = true;
    dialog.close("confirm");
  });

  actions.append(cancel, confirm);
  form.append(title, message, actions);
  dialog.append(form);

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    record.outcome = false;
    dialog.close("cancel");
  });

  dialog.addEventListener("close", () => {
    const confirmed = record.outcome ?? dialog.returnValue === "confirm";
    settle(record, confirmed);
  });

  record.dialog = dialog;
  document.body.append(dialog);
  return { dialog, title, message, cancel, confirm };
}

export function confirmAction(message, { title = "Confirm action", confirmLabel = "Confirm", danger = true, opener = document.activeElement } = {}) {
  // Each confirmation owns its own <dialog> and promise. Replacing a pending
  // confirmation destroys the old dialog instead of reusing it, so a delayed
  // close event from the old request cannot settle or refocus the new request.
  const currentFocus = document.activeElement;
  const focusReturnTarget = activeRequest?.dialog?.contains(currentFocus) ? activeRequest.opener : opener;
  cancelActive({ restore:false });

  const record = {
    dialog:null,
    opener: focusReturnTarget,
    resolve:null,
    settled:false,
    outcome:null
  };
  const parts = createDialog(record);
  parts.title.textContent = String(title || "Confirm action");
  parts.message.textContent = String(message || "Continue?");
  parts.confirm.textContent = String(confirmLabel || "Confirm");
  parts.confirm.classList.toggle("danger", danger === true);
  parts.dialog.returnValue = "";

  activeRequest = record;
  const promise = new Promise((resolve) => { record.resolve = resolve; });
  parts.dialog.showModal();
  parts.cancel.focus();
  return promise;
}
