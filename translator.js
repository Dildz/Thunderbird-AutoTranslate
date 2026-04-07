// Shared helper: call the unofficial Google Translate endpoint.
// Used only from the background script (content scripts can't reach it cross-origin).

const GT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_CHUNK = 4500; // Google free endpoint practical cap per request.

// Split `text` into chunks <= MAX_CHUNK, preferring paragraph/sentence boundaries.
function splitForTranslate(text) {
  if (text.length <= MAX_CHUNK) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK) {
    let cut = remaining.lastIndexOf("\n\n", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = remaining.lastIndexOf("\n", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = remaining.lastIndexOf(". ", MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

async function translateChunk(text, target, source) {
  const url = new URL(GT_ENDPOINT);
  url.search = new URLSearchParams({
    client: "gtx",
    sl: source || "auto",
    tl: target,
    dt: "t",
    q: text,
  }).toString();

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}`);
  }
  const data = await res.json();
  // data[0] is an array of [translatedSegment, originalSegment, ...].
  // data[2] is the detected source language (only reliable on the first chunk).
  const translated = (data[0] || [])
    .map((seg) => (seg && seg[0]) || "")
    .join("");
  const detectedSource = data[2];
  return { translated, detectedSource };
}

// Public: translate `text` into `target`, auto-detecting source by default.
// Returns { translated, detectedSource }.
async function callGoogleTranslate(text, target, source = "auto") {
  if (!text || !text.trim()) {
    return { translated: text, detectedSource: source };
  }

  const chunks = splitForTranslate(text);
  let detectedSource = source;
  const out = [];

  for (let i = 0; i < chunks.length; i++) {
    const { translated, detectedSource: det } = await translateChunk(
      chunks[i],
      target,
      source
    );
    if (i === 0 && det) detectedSource = det;
    out.push(translated);
  }

  return { translated: out.join(""), detectedSource };
}
