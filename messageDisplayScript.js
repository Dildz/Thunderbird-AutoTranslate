// Runs inside the displayed-message iframe. Two responsibilities:
//   1. Collect text nodes, hand them to the background for translation,
//      then write the translated strings back into the same nodes so that
//      all HTML/CSS/images/links/layout stay intact.
//   2. Restore the originals on demand via a banner click.

(function () {
  if (window.__inlineTranslatorInstalled) return;
  window.__inlineTranslatorInstalled = true;

  const BANNER_ID = "inline-translator-banner";
  const ERROR_ID = "inline-translator-error";

  let originalTexts = null; // string[] aligned with collectedNodes
  let collectedNodes = null; // Text[]

  // ---- DOM helpers ----------------------------------------------------

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const tag = n.parentNode?.nodeName;
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

  function injectStylesOnce() {
    if (document.getElementById("inline-translator-styles")) return;
    const style = document.createElement("style");
    style.id = "inline-translator-styles";
    style.textContent = `
      #${BANNER_ID}, #${ERROR_ID} {
        font: 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
        border-radius: 4px;
        padding: 6px 10px;
        margin: 0 0 8px 0;
        user-select: none;
      }
      #${BANNER_ID} {
        background: #fff4c2;
        color: #3a2f00;
        border: 1px solid #e6cf6a;
        cursor: pointer;
      }
      #${BANNER_ID}:hover { background: #ffeea0; }
      #${ERROR_ID} {
        background: #fde2e2;
        color: #7a1f1f;
        border: 1px solid #e69c9c;
      }
    `;
    document.head?.appendChild(style) || document.body.appendChild(style);
  }

  function showBanner(detectedSource, targetLang) {
    document.getElementById(BANNER_ID)?.remove();
    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.title = "Click to restore the original message";
    banner.textContent = `Translated from ${detectedSource || "auto"} \u2192 ${targetLang || "target"}. Click to restore original.`;
    banner.addEventListener("click", restoreOriginal);
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function showError(message) {
    document.getElementById(ERROR_ID)?.remove();
    const bar = document.createElement("div");
    bar.id = ERROR_ID;
    bar.textContent = "Translation failed: " + message;
    document.body.insertBefore(bar, document.body.firstChild);
    setTimeout(() => bar.remove(), 6000);
  }

  // ---- Apply / restore ------------------------------------------------

  function applyTranslations(nodes, originals, translations) {
    originalTexts = originals;
    collectedNodes = nodes;
    for (let i = 0; i < nodes.length; i++) {
      if (translations[i] != null) nodes[i].nodeValue = translations[i];
    }
  }

  function restoreOriginal() {
    if (!collectedNodes || !originalTexts) return;
    for (let i = 0; i < collectedNodes.length; i++) {
      collectedNodes[i].nodeValue = originalTexts[i];
    }
    collectedNodes = null;
    originalTexts = null;
    document.getElementById(BANNER_ID)?.remove();
  }

  // ---- Kickoff --------------------------------------------------------

  async function kickoff(mode) {
    if (collectedNodes) return; // already translated; user must restore first
    injectStylesOnce();

    const nodes = collectTextNodes(document.body);
    if (!nodes.length) return;
    const texts = nodes.map((n) => n.nodeValue);

    let res;
    try {
      res = await messenger.runtime.sendMessage({ type: "translate", texts, mode });
    } catch (e) {
      showError("messaging failed: " + (e?.message || e));
      return;
    }

    if (!res?.ok) {
      showError(res?.error || "unknown error");
      return;
    }
    if (res.skip) return;

    applyTranslations(nodes, texts, res.translations || []);
    showBanner(res.detectedSource, res.targetLang);
  }

  messenger.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    if (msg.type === "kickoff") kickoff(msg.mode);
    else if (msg.type === "restoreOriginal") restoreOriginal();
  });
})();
