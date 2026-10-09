export function captureFocusReturnId(activeElement) {
  return typeof activeElement?.id === "string" ? activeElement.id : "";
}

export function restoreFocusById(documentRef, id) {
  if (!id) return false;
  const target = documentRef?.getElementById?.(id);
  if (!target?.isConnected || target.disabled || typeof target.focus !== "function") return false;
  target.focus();
  return true;
}
