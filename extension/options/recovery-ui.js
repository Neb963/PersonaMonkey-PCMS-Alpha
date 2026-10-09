// v0.6 data-management UI bootstrap. Recovery controls themselves are owned by
// data-management.js; this module loads the corrective persona/cookie UX layer
// after the legacy options controller so it can reuse the existing page shell.
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = "v062.css";
document.head.append(stylesheet);

await import("./cookies.js");
await import("./profile-ui.js");
await import("./personas-v07.js");
