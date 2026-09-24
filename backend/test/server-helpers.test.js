import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getName,
  getSongArtist,
  getSongTitle,
  normalizeName,
  normalizeSelectedSong,
  runPythonJson,
  tagNamesMatchGenres,
  toSong,
  validateQuery,
} from "../src/server.js";

const originalEnvPythonPath = process.env.ENV_PYTHON_PATH;
const originalModelServiceUrl = process.env.MODEL_SERVICE_URL;
const originalConsoleLog = console.log;
const originalFetch = global.fetch;

afterEach(() => {
  if (originalEnvPythonPath === undefined) {
    delete process.env.ENV_PYTHON_PATH;
  } else {
    process.env.ENV_PYTHON_PATH = originalEnvPythonPath;
  }
  if (originalModelServiceUrl === undefined) {
    delete process.env.MODEL_SERVICE_URL;
  } else {
    process.env.MODEL_SERVICE_URL = originalModelServiceUrl;
  }
  console.log = originalConsoleLog;
  global.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("server helper functions", () => {
  it("validateQuery trims valid q parameters", () => {
    const res = createResponse();

    assert.equal(validateQuery({ query: { q: "  synth pop  " } }, res), "synth pop");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, undefined);
  });

  it("validateQuery rejects missing, empty, and too-long q parameters", () => {
    for (const q of [undefined, "", "   ", "a".repeat(201)]) {
      const res = createResponse();

      assert.equal(validateQuery({ query: { q } }, res), null);
      assert.equal(res.statusCode, 400);
      assert.ok(res.body.error);
    }
  });

  it("validateQuery rejects non-string q parameters", () => {
    const res = createResponse();

    assert.equal(validateQuery({ query: { q: ["rock"] } }, res), null);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Missing or empty query parameter "q"' });
  });

  it("normalizes selected songs and rejects missing fields", () => {
    assert.deepEqual(
      normalizeSelectedSong({ title: "  Dreams ", artist: " Fleetwood Mac " }, "startSong"),
      { name: "Dreams", artist: "Fleetwood Mac" },
    );

    assert.throws(
      () => normalizeSelectedSong({ name: "Dreams" }, "startSong"),
      /startSong\.name and startSong\.artist are required/,
    );
    assert.throws(
      () => normalizeSelectedSong(null, "endSong"),
      /endSong is required/,
    );
  });

  it("normalizes song, artist, and genre helper shapes", () => {
    assert.equal(getName("Rock"), "Rock");
    assert.equal(getName({ name: "Jazz" }), "Jazz");
    assert.equal(normalizeName("  Dream Pop "), "dream pop");
    assert.deepEqual(toSong({ name: "Cellophane", artist: { name: "FKA twigs" } }), {
      name: "Cellophane",
      artist: "FKA twigs",
    });
    assert.equal(toSong({ name: "Untitled" }), null);
    assert.equal(getSongTitle({ title: "Roads" }), "Roads");
    assert.equal(getSongTitle({ name: "Glory Box" }), "Glory Box");
    assert.equal(getSongArtist({ artist: { name: "Portishead" } }), "Portishead");
    assert.equal(getSongArtist({ artist: "Portishead" }), "Portishead");
  });

  it("matches avoided genres literally after punctuation normalization", () => {
    assert.equal(tagNamesMatchGenres(["singer-songwriter"], ["singer songwriter"]), true);
    assert.equal(tagNamesMatchGenres(["singer/songwriter"], [{ name: "singer songwriter" }]), true);
    assert.equal(tagNamesMatchGenres(["rock"], ["rock"]), true);
    assert.equal(tagNamesMatchGenres(["alternative rock"], ["rock"]), false);
    assert.equal(tagNamesMatchGenres(["heavy metal"], ["rock"]), false);
  });

  it("runPythonJson posts JSON to the model service and parses the response", async () => {
    process.env.MODEL_SERVICE_URL = "http://127.0.0.1:8000";
    let requestedUrl;
    let requestedOptions;
    global.fetch = async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return jsonResponse({ ok: true, payload: JSON.parse(options.body) });
    };

    const result = await runPythonJson("recommend", { genres: ["rock"] });

    assert.equal(requestedUrl, "http://127.0.0.1:8000/recommend");
    assert.equal(requestedOptions.method, "POST");
    assert.deepEqual(result, { ok: true, payload: { genres: ["rock"] } });
  });

  it("runPythonJson uses MODEL_SERVICE_URL when provided", async () => {
    process.env.MODEL_SERVICE_URL = "http://model-service.test";
    let requestedUrl;
    global.fetch = async (url) => {
      requestedUrl = String(url);
      return jsonResponse({ ok: true });
    };

    await runPythonJson("process-preferences", {});

    assert.equal(requestedUrl, "http://model-service.test/process-preferences");
  });

  it("runPythonJson rejects model service HTTP errors with body detail", async () => {
    global.fetch = async () => jsonResponse({ detail: "model failed" }, 502);

    await assert.rejects(
      () => runPythonJson("recommend", {}),
      /model failed/,
    );
  });

  it("runPythonJson rejects network failures", async () => {
    global.fetch = async () => {
      throw new Error("connection refused");
    };

    await assert.rejects(
      () => runPythonJson("recommend", {}),
      /Could not reach model service for recommend: connection refused/,
    );
  });
});
