// Background script. Owns settings, network, and the messaging boundary
// between the auto-trigger event and the in-page display script.
// Loaded after translator.js (see manifest.background.scripts).

const DEBUG = false;
const log = (...a) => DEBUG && console.log("[AutoTranslate]", ...a);

const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: "en",
  // Optional overrides: { from: "de", to: "fr", enabled: true } means
  // "when a message is detected as German, translate it to French instead
  // of the default targetLang". Anything not covered by a rule is still
  // translated to targetLang.
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

async function ensureDisplayScript(tabId) {
  await messenger.tabs.executeScript(tabId, { file: "messageDisplayScript.js" });
}

// ---- Translation request handler --------------------------------------

// Pick the longest non-trivial string for language detection. Capped to 300
// chars to keep the probe call cheap.
function pickProbe(texts) {
  let best = "";
  for (const t of texts) {
    if (t && t.length > best.length) best = t;
    if (best.length >= 300) break;
  }
  return best.slice(0, 300);
}

function resolveTarget(detectedSource, settings) {
  const rule = (settings.autoRules || [])
    .filter((r) => r && r.enabled)
    .find((r) => r.from === detectedSource);
  return (rule && rule.to) || settings.targetLang;
}

async function handleTranslate({ texts, force }) {
  if (!Array.isArray(texts) || !texts.length) return { ok: true, skip: true };

  const settings = await loadSettings();
  if (!settings.enabled && !force) return { ok: true, skip: true };

  const probe = pickProbe(texts);
  if (!probe.trim()) return { ok: true, skip: true };

  const { detectedSource } = await callGoogleTranslate(probe, settings.targetLang);
  if (!detectedSource) return { ok: true, skip: true };

  const target = resolveTarget(detectedSource, settings);
  if (detectedSource === target && !force) {
    log("source already matches target, skipping", detectedSource);
    return { ok: true, skip: true };
  }

  const { translations, detectedSource: src } = await translateBatch(texts, target);
  return {
    ok: true,
    translations,
    detectedSource: src || detectedSource,
    targetLang: target,
  };
}

messenger.runtime.onMessage.addListener((msg) => {
  if (!msg) return false;
  if (msg.type === "translate") {
    return handleTranslate(msg).catch((e) => {
      console.error("[AutoTranslate] handleTranslate failed", e);
      return { ok: false, error: String(e?.message || e) };
    });
  }
  if (msg.type === "manualKickoff") {
    return manualKickoff().catch((e) => {
      console.error("[AutoTranslate] manualKickoff failed", e);
      return { ok: false, error: String(e?.message || e) };
    });
  }
  return false;
});

// ---- Triggers ----------------------------------------------------------

async function kickoff(tab, opts = {}) {
  await ensureDisplayScript(tab.id);
  await messenger.tabs.sendMessage(tab.id, { type: "kickoff", force: !!opts.force });
}

// Triggered by the "Translate now" button in the popup. Finds the active mail
// tab, clears its dedup entry so the same message can be re-translated, and
// fires a forced kickoff that bypasses the enabled flag and same-language skip.
async function manualKickoff() {
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false, error: "No active tab." };

  try {
    const messages = await messenger.messageDisplay.getDisplayedMessages(tab.id);
    const first = messages?.[0];
    if (first) autoTranslated.delete(first.id);
  } catch (_) {
    /* tab might not be a message display tab — let kickoff fail loudly below */
  }

  try {
    await kickoff(tab, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// The toolbar button is wired in the manifest as a popup (`default_popup`),
// which opens the settings UI as a small attached panel. Translation itself
// is fully automatic on every displayed message — see the listener below.

messenger.messageDisplay.onMessagesDisplayed.addListener(async (tab, messageList) => {
  const settings = await loadSettings();
  if (!settings.enabled) return;

  const messages =
    messageList?.messages ||
    (await messenger.messageDisplay.getDisplayedMessages(tab.id));
  const first = messages?.[0];
  if (!first || autoTranslated.has(first.id)) return;
  autoTranslated.add(first.id);

  log("auto kickoff for msg", first.id);
  kickoff(tab);
});
