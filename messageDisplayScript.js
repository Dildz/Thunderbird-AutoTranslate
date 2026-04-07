// Runs inside the displayed-message iframe.
// Two responsibilities:
//   1. Collect translatable text nodes from the rendered message DOM and
//      report their text back to the background, then write the translated
//      text back into the same nodes (preserving all HTML/CSS/images/links).
//   2. Restore the original text on demand.

(function () {
  if (window.__inlineTranslatorInstalled) return;
  window.__inlineTranslatorInstalled = true;

  let originalTexts = null; // string[] aligned with collectedNodes
  let collectedNodes = null; // Text node[]

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function buildBanner(detectedSource, targetLang) {
    const banner = document.createElement("div");
    banner.id = "inline-translator-banner";
    banner.style.cssText = [
      "font: 12px/1.4 system-ui, sans-serif",
      "background: #fff4c2",
      "color: #3a2f00",
      "border: 1px solid #e6cf6a",
      "border-radius: 4px",
      "padding: 6px 10px",
      "margin: 0 0 8px 0",
      "cursor: pointer",
      "user-select: none",
    ].join(";");
    banner.title = "Click to restore the original message";
    banner.textContent =
      "Translated from " +
      (detectedSource || "auto") +
      " \u2192 " +
      (targetLang || "target") +
      ". Click to restore original.";
    banner.addEventListener("click", restoreOriginal);
    return banner;
  }

  function insertBanner(detectedSource, targetLang) {
    const existing = document.getElementById("inline-translator-banner");
    if (existing) existing.remove();
    const banner = buildBanner(detectedSource, targetLang);
    document.body.insertBefore(banner, document.body.firstChild);
  }

  async function translateInPlace(targetLang) {
    if (collectedNodes) {
      // Already translated; nothing to do (user can restore first).
      return;
    }
    const nodes = collectTextNodes(document.body);
    if (!nodes.length) return;

    const texts = nodes.map((n) => n.nodeValue);

    let response;
    try {
      response = await messenger.runtime.sendMessage({
        type: "translateTexts",
        texts,
        target: targetLang,
      });
    } catch (e) {
      showError("messaging failed: " + (e && e.message ? e.message : e));
      return;
    }

    if (!response || !response.ok) {
      showError((response && response.error) || "translation failed");
      return;
    }

    const translations = response.translations || [];
    // Save originals so we can restore.
    originalTexts = texts.slice();
    collectedNodes = nodes;

    for (let i = 0; i < nodes.length; i++) {
      if (translations[i] != null) {
        nodes[i].nodeValue = translations[i];
      }
    }

    insertBanner(response.detectedSource, targetLang);
  }

  function restoreOriginal() {
    if (!collectedNodes || !originalTexts) return;
    for (let i = 0; i < collectedNodes.length; i++) {
      collectedNodes[i].nodeValue = originalTexts[i];
    }
    collectedNodes = null;
    originalTexts = null;
    const banner = document.getElementById("inline-translator-banner");
    if (banner) banner.remove();
  }

  function showError(message) {
    const bar = document.createElement("div");
    bar.style.cssText =
      "font:12px/1.4 system-ui,sans-serif;background:#fde2e2;color:#7a1f1f;border:1px solid #e69c9c;border-radius:4px;padding:6px 10px;margin:0 0 8px 0;";
    bar.textContent = "Translation failed: " + message;
    document.body.insertBefore(bar, document.body.firstChild);
    setTimeout(() => bar.remove(), 6000);
  }

  messenger.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "translateInPlace") {
      translateInPlace(msg.targetLang);
    } else if (msg.type === "restoreOriginal") {
      restoreOriginal();
    } else if (msg.type === "translationError") {
      showError(msg.message || "unknown error");
    }
  });
})();
