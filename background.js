// Background script: orchestrates translation.
// Relies on translator.js (loaded first via manifest "background.scripts").

const DEFAULT_SETTINGS = {
  targetLang: "en",
  // Each rule: { from: "de", to: "en", enabled: true }. `to` is optional; if
  // omitted we fall back to `targetLang`.
  autoRules: [],
};

// Sentinel placed between text-node strings when batched into a single
// Google Translate request. Chosen to be unlikely to be altered by the
// translation engine, and easy to split back out.
const SENTINEL = "\n\n@@@@@~~~~~@@@@@\n\n";

// Remember which messages we've already auto-translated in this session, so
// switching back and forth in the message list doesn't retranslate endlessly.
const autoTranslated = new Set();

async function loadSettings() {
  const stored = await messenger.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Register the in-page script so it auto-injects into future message displays.
// Best-effort; we also inject on-demand below for the currently shown message.
(async () => {
  try {
    if (messenger.messageDisplayScripts && messenger.messageDisplayScripts.register) {
      await messenger.messageDisplayScripts.register({
        js: [{ file: "messageDisplayScript.js" }],
      });
      console.log("[InlineTranslator] messageDisplayScripts registered");
    }
  } catch (e) {
    console.warn("[InlineTranslator] register failed (will fall back to executeScript)", e);
  }
})();

// Ensure the display script is present in the given tab right now.
async function ensureDisplayScript(tabId) {
  try {
    await messenger.tabs.executeScript(tabId, {
      file: "messageDisplayScript.js",
    });
  } catch (e) {
    console.error("[InlineTranslator] executeScript failed", e);
    throw e;
  }
}

// ---- Batch translation -------------------------------------------------

// Translate an array of text-node strings while preserving 1:1 alignment.
// Strategy: pack as many texts as fit under MAX_CHUNK joined by SENTINEL,
// translate that group as one request (so we keep node count == output count),
// then split the response on the same sentinel.
async function translateTexts(texts, target) {
  const MAX_CHUNK = 4500;
  const result = new Array(texts.length);
  let detectedSource = null;

  let i = 0;
  while (i < texts.length) {
    // Build a group starting at i.
    const groupIdx = [];
    let combined = "";
    while (i < texts.length) {
      const piece = texts[i];
      const addition = combined.length === 0 ? piece : SENTINEL + piece;
      if (combined.length + addition.length > MAX_CHUNK && groupIdx.length > 0) {
        break;
      }
      combined += addition;
      groupIdx.push(i);
      i++;
      // If a single piece is already huge, translate it alone.
      if (combined.length > MAX_CHUNK) break;
    }

    const { translated, detectedSource: det } = await callGoogleTranslate(
      combined,
      target
    );
    if (!detectedSource && det) detectedSource = det;

    // Split back. The translation engine usually preserves the @ run, but be
    // tolerant of small whitespace shifts around it.
    let parts = translated.split(SENTINEL);
    if (parts.length !== groupIdx.length) {
      // Fallback: try a looser split on a normalized form.
      const loose = translated.replace(/\s*@@@@@~~~~~@@@@@\s*/g, SENTINEL);
      parts = loose.split(SENTINEL);
    }

    if (parts.length === groupIdx.length) {
      for (let k = 0; k < groupIdx.length; k++) {
        result[groupIdx[k]] = parts[k];
      }
    } else {
      // Last-resort fallback: translate this group's items one-by-one so we
      // never lose alignment, even if it costs extra requests.
      console.warn(
        "[InlineTranslator] sentinel split mismatch, falling back to per-node",
        { expected: groupIdx.length, got: parts.length }
      );
      for (const idx of groupIdx) {
        const single = await callGoogleTranslate(texts[idx], target);
        if (!detectedSource && single.detectedSource) {
          detectedSource = single.detectedSource;
        }
        result[idx] = single.translated;
      }
    }
  }

  return { translations: result, detectedSource };
}

// ---- Body extraction (only used for auto-rule language detection) -------

function pickBody(part, acc = { html: null, plain: null }) {
  if (!part) return acc;
  if (part.body) {
    if (part.contentType && part.contentType.startsWith("text/html") && !acc.html) {
      acc.html = part.body;
    } else if (
      part.contentType &&
      part.contentType.startsWith("text/plain") &&
      !acc.plain
    ) {
      acc.plain = part.body;
    }
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) pickBody(p, acc);
  }
  return acc;
}

function htmlToText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return cleaned
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function getDisplayedBodyForDetection(tabId) {
  const messages = await messenger.messageDisplay.getDisplayedMessages(tabId);
  if (!messages || !messages.length) return null;
  const msg = messages[0];
  const full = await messenger.messages.getFull(msg.id);
  const { html, plain } = pickBody(full);
  const bodyText = plain || (html ? htmlToText(html) : "");
  return { msg, bodyText };
}

// ---- Core translate flow ----------------------------------------------

async function triggerTranslate(tab, target) {
  await ensureDisplayScript(tab.id);
  await messenger.tabs.sendMessage(tab.id, {
    type: "translateInPlace",
    targetLang: target,
  });
}

async function translateTab(tab, { force = false } = {}) {
  console.log("[InlineTranslator] translateTab called", { tabId: tab.id, force });
  try {
    const settings = await loadSettings();
    await triggerTranslate(tab, settings.targetLang);
  } catch (e) {
    console.error("[InlineTranslator] translate failed", e);
  }
}

async function maybeAutoTranslate(tab) {
  try {
    const settings = await loadSettings();
    const rules = (settings.autoRules || []).filter((r) => r && r.enabled);
    if (!rules.length) return;

    const data = await getDisplayedBodyForDetection(tab.id);
    if (!data) return;
    const { msg, bodyText } = data;
    if (autoTranslated.has(msg.id)) return;
    if (!bodyText.trim()) return;

    const probe = bodyText.slice(0, 500);
    const { detectedSource } = await callGoogleTranslate(probe, settings.targetLang);
    if (!detectedSource) return;

    const match = rules.find((r) => r.from === detectedSource);
    if (!match) return;

    const target = match.to || settings.targetLang;
    autoTranslated.add(msg.id);
    await triggerTranslate(tab, target);
  } catch (e) {
    console.error("[InlineTranslator] auto-translate failed", e);
  }
}

// ---- Messages from the display script ---------------------------------

messenger.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "translateTexts") return false;
  // Return a promise so the display script's await resolves.
  return (async () => {
    try {
      const { translations, detectedSource } = await translateTexts(
        msg.texts,
        msg.target
      );
      return { ok: true, translations, detectedSource };
    } catch (e) {
      console.error("[InlineTranslator] translateTexts failed", e);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  })();
});

// ---- Event wiring ------------------------------------------------------

console.log("[InlineTranslator] background script loaded");

messenger.messageDisplayAction.onClicked.addListener((tab) => {
  console.log("[InlineTranslator] toolbar button clicked", tab.id);
  translateTab(tab, { force: true });
});

messenger.messageDisplay.onMessagesDisplayed.addListener((tab) => {
  console.log("[InlineTranslator] onMessagesDisplayed", tab.id);
  maybeAutoTranslate(tab);
});
