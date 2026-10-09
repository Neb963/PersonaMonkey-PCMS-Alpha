// ==UserScript==
// @name         PersonaMonkey Mullvad status signal
// @namespace    personamonkey.examples
// @version      1.0.0
// @description  Captures the visible Mullvad status page text and signals PersonaMonkey workflow completion.
// @match        https://am.i.mullvad.net/*
// @match        https://ipv4.am.i.mullvad.net/*
// @run-at       document-idle
// @grant        Persona.signal
// ==/UserScript==

(() => {
  const text = (document.body?.innerText || document.documentElement?.innerText || "").trim();
  Persona.complete({
    url: location.href,
    title: document.title,
    text: text.slice(0, 1000)
  });
})();
