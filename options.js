// Options UI: manages target language + auto-translate rules in storage.local.

const LANGUAGES = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["de", "German"],
  ["tr", "Turkish"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["no", "Norwegian"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["el", "Greek"],
  ["ar", "Arabic"],
  ["he", "Hebrew"],
  ["fa", "Persian"],
  ["hi", "Hindi"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["id", "Indonesian"],
];

const DEFAULTS = { enabled: true, targetLang: "en", autoRules: [] };

const enabledCheckbox = document.getElementById("enabled");
const targetSelect = document.getElementById("targetLang");
const rulesBody = document.getElementById("rulesBody");
const addBtn = document.getElementById("addRule");
const saveBtn = document.getElementById("save");
const translateBtn = document.getElementById("translateNow");
const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#a12a2a" : "#2a7a2a";
  if (text) setTimeout(() => (statusEl.textContent = ""), 2500);
}

function buildLanguageOptions(select, { includeAuto, includeEmpty }) {
  select.innerHTML = "";
  if (includeEmpty) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(use default)";
    select.appendChild(opt);
  }
  for (const [code, label] of LANGUAGES) {
    if (code === "auto" && !includeAuto) continue;
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${label} (${code})`;
    select.appendChild(opt);
  }
}

function addRuleRow(rule = { from: "de", to: "", enabled: true }) {
  const tr = document.createElement("tr");

  const tdEnabled = document.createElement("td");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!rule.enabled;
  tdEnabled.appendChild(cb);

  const tdFrom = document.createElement("td");
  const fromSel = document.createElement("select");
  buildLanguageOptions(fromSel, { includeAuto: false, includeEmpty: false });
  fromSel.value = rule.from || "de";
  tdFrom.appendChild(fromSel);

  const tdTo = document.createElement("td");
  const toSel = document.createElement("select");
  buildLanguageOptions(toSel, { includeAuto: false, includeEmpty: true });
  toSel.value = rule.to || "";
  tdTo.appendChild(toSel);

  const tdRm = document.createElement("td");
  const rmBtn = document.createElement("button");
  rmBtn.type = "button";
  rmBtn.textContent = "Remove";
  rmBtn.addEventListener("click", () => tr.remove());
  tdRm.appendChild(rmBtn);

  tr.append(tdEnabled, tdFrom, tdTo, tdRm);
  rulesBody.appendChild(tr);
}

function collectRules() {
  const rules = [];
  for (const tr of rulesBody.querySelectorAll("tr")) {
    const [cb, fromSel, toSel] = tr.querySelectorAll("input, select");
    rules.push({
      enabled: cb.checked,
      from: fromSel.value,
      to: toSel.value || "",
    });
  }
  return rules;
}

async function load() {
  buildLanguageOptions(targetSelect, { includeAuto: false, includeEmpty: false });
  const stored = await messenger.storage.local.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  enabledCheckbox.checked = !!settings.enabled;
  targetSelect.value = settings.targetLang;
  rulesBody.innerHTML = "";
  for (const rule of settings.autoRules) addRuleRow(rule);
}

async function save() {
  const payload = {
    enabled: enabledCheckbox.checked,
    targetLang: targetSelect.value,
    autoRules: collectRules(),
  };
  await messenger.storage.local.set(payload);
  setStatus("Saved.");
}

async function translateNow() {
  setStatus("Translating…");
  try {
    const res = await messenger.runtime.sendMessage({ type: "manualKickoff" });
    if (res?.ok) {
      setStatus("Done.");
      // Close the popup so the user sees the translated message immediately.
      setTimeout(() => window.close(), 400);
    } else {
      setStatus(res?.error || "Failed.", true);
    }
  } catch (e) {
    setStatus(String(e?.message || e), true);
  }
}

addBtn.addEventListener("click", () => addRuleRow());
saveBtn.addEventListener("click", save);
translateBtn.addEventListener("click", translateNow);

load();
