// Background script. Owns settings, network, and the messaging boundary
// between the toolbar/auto-trigger events and the in-page display script.
// Loaded after translator.js (see manifest.background.scripts).

const DEBUG = false;
const log = (...a) => DEBUG && console.log("[InlineTranslator]", ...a);

const DEFAULT_SETTINGS = {
  targetLang: "en",
  // { from: "de", to: "en"|"", enabled: true }. Empty `to` means "use targetLang".
  autoRules: [],
};

// Messages we've already auto-translated this session — keyed by message id.
// Prevents `onMessagesDisplayed` from re-firing translations as the user
// scrolls back and forth.
const autoTranslated = new Set();

async function loadSettings() {
  const stored = await messenger.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ---- Display script injection -----------------------------------------

// Best-effort registration so future message displays auto-pick the script.
(async () => {
  try {
    if (messenger.messageDisplayScripts?.register) {
      await messenger.messageDisplayScripts.register({
        js: [{ file: "messageDisplayScript.js" }],
      });
    }
  } catch (e) {
    log("register failed (ok, executeScript fallback exists)", e);
  }
})();

// Inject on-demand for the message that's already on screen. Idempotent —
// the script guards itself with window.__inlineTranslatorInstalled.
async function ensureDisplayScript(tabId) {
  await messenger.tabs.executeScript(tabId, { file: "messageDisplayScript.js" });
}

// ---- Translation request handler --------------------------------------

// Pick the longest non-trivial string for language detection. Falls back to
// the first text if nothing better exists. Capped to 300 chars to keep the
// probe call cheap.
function pickProbe(texts) {
  let best = "";
  for (const t of texts) {
    if (t && t.length > best.length) best = t;
    if (best.length >= 300) break;
  }
  return best.slice(0, 300);
}

async function handleTranslate({ texts, mode }) {
  if (!Array.isArray(texts) || !texts.length) {
    return { ok: true, skip: true };
  }

  const settings = await loadSettings();

  if (mode === "auto") {
    const rules = (settings.autoRules || []).filter((r) => r && r.enabled);
    if (!rules.length) return { ok: true, skip: true };

    const probe = pickProbe(texts);
    if (!probe.trim()) return { ok: true, skip: true };

    const { detectedSource } = await callGoogleTranslate(probe, settings.targetLang);
    if (!detectedSource) return { ok: true, skip: true };

    const rule = rules.find((r) => r.from === detectedSource);
    if (!rule) {
      log("auto: no rule for", detectedSource);
      return { ok: true, skip: true };
    }

    const target = rule.to || settings.targetLang;
    const { translations, detectedSource: src } = await translateBatch(texts, target);
    return {
      ok: true,
      translations,
      detectedSource: src || detectedSource,
      targetLang: target,
    };
  }

  // Manual click — always translate to settings.targetLang.
  const { translations, detectedSource } = await translateBatch(texts, settings.targetLang);
  return {
    ok: true,
    translations,
    detectedSource,
    targetLang: settings.targetLang,
  };
}

messenger.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "translate") return false;
  return handleTranslate(msg).catch((e) => {
    console.error("[InlineTranslator] handleTranslate failed", e);
    return { ok: false, error: String(e?.message || e) };
  });
});

// ---- Triggers ----------------------------------------------------------

async function kickoff(tab, mode) {
  try {
    await ensureDisplayScript(tab.id);
    await messenger.tabs.sendMessage(tab.id, { type: "kickoff", mode });
  } catch (e) {
    console.error("[InlineTranslator] kickoff failed", e);
  }
}

messenger.messageDisplayAction.onClicked.addListener((tab) => {
  log("toolbar click", tab.id);
  kickoff(tab, "manual");
});

messenger.messageDisplay.onMessagesDisplayed.addListener(async (tab, messageList) => {
  // Cheap pre-filter: only run when the user has at least one auto-rule, and
  // the message hasn't been processed already.
  const settings = await loadSettings();
  if (!settings.autoRules?.some((r) => r && r.enabled)) return;

  const messages = messageList?.messages || (await messenger.messageDisplay.getDisplayedMessages(tab.id));
  const first = messages?.[0];
  if (!first || autoTranslated.has(first.id)) return;
  autoTranslated.add(first.id);

  log("auto kickoff for msg", first.id);
  kickoff(tab, "auto");
});
