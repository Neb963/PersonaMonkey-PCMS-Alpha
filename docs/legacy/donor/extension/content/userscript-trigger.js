(() => {
  const send = (stage) => {
    try {
      browser.runtime.sendMessage({ type: "US_STAGE", stage, url: location.href }).catch(() => {});
    } catch {}
  };

  send("document_start");

  const sendEnd = () => send("document_end");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sendEnd, { once: true });
  else queueMicrotask(sendEnd);

  const sendIdle = () => setTimeout(() => send("document_idle"), 0);
  if (document.readyState === "complete") sendIdle();
  else window.addEventListener("load", sendIdle, { once: true });
})();
