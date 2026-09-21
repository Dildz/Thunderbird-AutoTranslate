// Runs inside the displayed-message iframe. Two responsibilities:
//   1. Collect text nodes, hand them to the background for translation,
//      then write the translated strings back into the same nodes so that
//      all HTML/CSS/images/links/layout stay intact.
//   2. Restore the originals on demand via a banner click.

(function () {
  if (window.__autoTranslateInstalled) return;
  window.__autoTranslateInstalled = true;

  const BANNER_ID = "auto-translate-banner";
  const ERROR_ID = "auto-translate-error";

  let originalTexts = null; // string[] aligned with collectedNodes
  let collectedNodes = null; // Text[]
  let inFlight = null; // Promise of the job currently running, if any

  // Whether what is on screen right now is our translation. Nodes captured
  // from an earlier render are detached, so a truthy `collectedNodes` on its
  // own proves nothing.
  function translationIsLive() {
    return !!(collectedNodes?.length && collectedNodes[0].isConnected);
  }

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
    if (document.getElementById("auto-translate-styles")) return;
    const style = document.createElement("style");
    style.id = "auto-translate-styles";
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

  function clearError() {
    document.getElementById(ERROR_ID)?.remove();
  }

  function showError(message) {
    clearError();
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
      if (collectedNodes[i].isConnected) {
        collectedNodes[i].nodeValue = originalTexts[i];
      }
    }
    collectedNodes = null;
    originalTexts = null;
    document.getElementById(BANNER_ID)?.remove();
  }

  // ---- Kickoff --------------------------------------------------------

  async function runTranslation(force) {
    if (translationIsLive()) {
      if (!force) return { ok: true, skip: true };
      restoreOriginal(); // forced re-run: revert then translate fresh
    } else {
      // Left over from a previous render of this document — drop it, the
      // nodes it points at are no longer on screen.
      collectedNodes = null;
      originalTexts = null;
    }

    if (!document.body) return { ok: true, skip: true };
    injectStylesOnce();

    const nodes = collectTextNodes(document.body);
    if (!nodes.length) return { ok: true, skip: true };
    const texts = nodes.map((n) => n.nodeValue);

    let res;
    try {
      res = await messenger.runtime.sendMessage({ type: "translate", texts, force });
    } catch (e) {
      const error = "messaging failed: " + (e?.message || e);
      showError(error);
      return { ok: false, error };
    }

    if (!res?.ok) {
      const error = res?.error || "unknown error";
      showError(error);
      return { ok: false, error };
    }
    if (res.skip) return { ok: true, skip: true };

    // The message was swapped out while we were waiting — writing into these
    // nodes would do nothing visible and would leave stale state behind.
    if (!nodes[0].isConnected) return { ok: true, skip: true };

    clearError();
    applyTranslations(nodes, texts, res.translations || []);
    showBanner(res.detectedSource, res.targetLang);
    return { ok: true };
  }

  // Serialises jobs within this document: a second kickoff can otherwise
  // collect the same nodes before the first has written to them, producing
  // two translations of the same text and two requests.
  function kickoff(force) {
    if (inFlight && !force) return inFlight;

    const previous = inFlight;
    const job = (async () => {
      if (previous) await previous.catch(() => {});
      return runTranslation(force);
    })();

    inFlight = job;
    job
      .finally(() => {
        // Only the job that is still the current one may clear the slot; a
        // newer forced job may already have taken it.
        if (inFlight === job) inFlight = null;
      })
      .catch(() => {});
    return job;
  }

  messenger.runtime.onMessage.addListener((msg) => {
    if (!msg?.type) return;
    // Returned so the sender can await the outcome rather than the handoff.
    if (msg.type === "kickoff") return kickoff(msg.force);
    if (msg.type === "restoreOriginal") restoreOriginal();
  });
})();
