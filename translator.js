// Translation helpers. Loaded into the background page before background.js.
// All Google Translate calls live here so the rest of the codebase never has
// to think about chunking, sentinels, or HTTP shapes.

const GT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

// Practical cap per request to the unofficial gtx endpoint.
const MAX_CHUNK = 4500;

// Sentinel inserted between text-node strings when packing many short pieces
// into one request. Chosen to be (a) unlikely to be touched by the engine,
// (b) easy to recover after small whitespace shifts, (c) cheap in characters.
const SENTINEL = "\n\n@@@@@~~~~~@@@@@\n\n";
const SENTINEL_LOOSE = /\s*@@@@@~~~~~@@@@@\s*/g;

// ---- Low-level: one HTTP call -----------------------------------------

async function gtRequest(text, target, source) {
  const url = new URL(GT_ENDPOINT);
  url.search = new URLSearchParams({
    client: "gtx",
    sl: source || "auto",
    tl: target,
    dt: "t",
    q: text,
  }).toString();

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = await res.json();

  // data[0] = [[translatedSegment, originalSegment, ...], ...]
  // data[2] = detected source language (only on the first request of a batch)
  const translated = (data[0] || []).map((seg) => (seg && seg[0]) || "").join("");
  return { translated, detectedSource: data[2] || null };
}

// ---- Single string, auto-chunked --------------------------------------

function splitLongString(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf("\n\n", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf("\n", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(". ", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

async function callGoogleTranslate(text, target, source = "auto") {
  if (!text || !text.trim()) return { translated: text, detectedSource: source };
  const chunks = splitLongString(text);
  let detectedSource = null;
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await gtRequest(chunks[i], target, source);
    if (i === 0) detectedSource = r.detectedSource;
    out.push(r.translated);
  }
  return { translated: out.join(""), detectedSource };
}

// ---- Batch of N strings, alignment preserved --------------------------

// Group `texts` into chunks of <= MAX_CHUNK joined by SENTINEL, translate
// each group in one request, split the response back. Returns an array the
// same length and order as `texts`.
async function translateBatch(texts, target) {
  const out = new Array(texts.length);
  let detectedSource = null;

  let i = 0;
  while (i < texts.length) {
    const groupIdx = [];
    let combined = "";
    while (i < texts.length) {
      const piece = texts[i];
      const addition = combined.length === 0 ? piece : SENTINEL + piece;
      if (combined.length + addition.length > MAX_CHUNK && groupIdx.length > 0) break;
      combined += addition;
      groupIdx.push(i);
      i++;
      if (combined.length > MAX_CHUNK) break;
    }

    const { translated, detectedSource: det } = await gtRequest(combined, target);
    if (!detectedSource && det) detectedSource = det;

    let parts = translated.split(SENTINEL);
    if (parts.length !== groupIdx.length) {
      parts = translated.replace(SENTINEL_LOOSE, SENTINEL).split(SENTINEL);
    }

    if (parts.length === groupIdx.length) {
      for (let k = 0; k < groupIdx.length; k++) out[groupIdx[k]] = parts[k];
    } else {
      // Fallback: translate this group's items individually so alignment
      // is guaranteed. Slower, but only used when sentinels get mangled.
      for (const idx of groupIdx) {
        const r = await gtRequest(texts[idx], target);
        if (!detectedSource && r.detectedSource) detectedSource = r.detectedSource;
        out[idx] = r.translated;
      }
    }
  }

  return { translations: out, detectedSource };
}
