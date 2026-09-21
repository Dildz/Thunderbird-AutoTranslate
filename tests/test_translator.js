// Self-check for translator.js. No framework: `node tests/test_translator.js`.
// Covers the retry/backoff decisions and batch alignment, which are the only
// parts here subtle enough to break silently.

const fs = require("fs");
const assert = require("assert");

const SRC = fs.readFileSync(require("path").join(__dirname, "..", "translator.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Load translator.js with `fetch` and the timers shadowed by parameters, so
// its top-level consts stay in scope and no real network or delay happens.
function load(fetchImpl) {
  const calls = [];
  const wrapped = async (url, init) => {
    calls.push(String(url));
    return fetchImpl(calls.length, String(url), init);
  };
  const fakeSetTimeout = (cb, ms) => {
    if (ms >= 5000) return 0; // the abort guard: never trip it under test
    return setTimeout(cb, 0); // backoff: collapse to ~immediate
  };
  const body = SRC + "\nreturn { gtRequest, translateBatch, callGoogleTranslate, MAX_CHUNK };";
  const api = new AsyncFunction("fetch", "setTimeout", "clearTimeout", body)(
    wrapped,
    fakeSetTimeout,
    () => {}
  );
  return { api, calls };
}

const ok = (segments, detected = "pl") => ({
  ok: true,
  status: 200,
  json: async () => [segments.map((s) => [s, s]), null, detected],
});
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

(async () => {
  // 1. 429 is transient: retry, then succeed.
  {
    const { api, calls } = load(async (n) =>
      n < 3 ? status(429) : ok(["Good morning"])
    );
    const r = await (await api).gtRequest("Dzień dobry", "en");
    assert.strictEqual(r.translated, "Good morning");
    assert.strictEqual(r.detectedSource, "pl");
    assert.strictEqual(calls.length, 3, "should have retried twice");
  }

  // 2. 400 is our bug, not theirs: fail immediately, do not burn the budget.
  {
    const { api, calls } = load(async () => status(400));
    await assert.rejects(() => (async () => (await api).gtRequest("x", "en"))(), /HTTP 400/);
    assert.strictEqual(calls.length, 1, "400 must not be retried");
  }

  // 3. A 200 carrying the bot-detection HTML page is transient.
  {
    let served = 0;
    const { api, calls } = load(async (n) => {
      if (n === 1) {
        served++;
        return { ok: true, status: 200, json: async () => { throw new SyntaxError("not json"); } };
      }
      return ok(["hello"]);
    });
    const r = await (await api).gtRequest("czesc", "en");
    assert.strictEqual(r.translated, "hello");
    assert.strictEqual(served, 1);
    assert.strictEqual(calls.length, 2);
  }

  // 4. A network abort (our timeout) is transient too.
  {
    const { api, calls } = load(async (n) => {
      if (n === 1) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      return ok(["hi"]);
    });
    const r = await (await api).gtRequest("hej", "en");
    assert.strictEqual(r.translated, "hi");
    assert.strictEqual(calls.length, 2);
  }

  // 5. Persistent 429 gives up rather than looping forever.
  {
    const { api, calls } = load(async () => status(429));
    await assert.rejects(() => (async () => (await api).gtRequest("x", "en"))(), /HTTP 429/);
    assert.strictEqual(calls.length, 4, "MAX_ATTEMPTS");
  }

  // 6. Batch alignment: N strings in, N strings out, same order.
  {
    const { api } = load(async (_n, url) => {
      const q = new URL(url).searchParams.get("q");
      return ok([q.toUpperCase()]);
    });
    const input = ["jeden", "dwa", "trzy"];
    const { translations, detectedSource } = await (await api).translateBatch(input, "en");
    assert.deepStrictEqual(translations, ["JEDEN", "DWA", "TRZY"]);
    assert.strictEqual(detectedSource, "pl");
  }

  console.log("translator.js: 6/6 checks passed");
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
