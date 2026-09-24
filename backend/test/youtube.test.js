import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const originalFetch = global.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  delete process.env.YOUTUBE_API_KEY;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("YouTube API helper", () => {
  it("returns the first matching YouTube API result", async () => {
    process.env.YOUTUBE_API_KEY = "yt-key";
    let requestedUrl;
    global.fetch = async (url) => {
      requestedUrl = new URL(url);
      return jsonResponse({
        items: [
          {
            id: { videoId: "abc123DEF45" },
            snippet: {
              title: "Massive Attack - Teardrop",
              tags: ["trip hop"],
            },
          },
        ],
      });
    };

    const { searchURL } = await import("../src/apis/youtube.js");
    const result = await searchURL("Teardrop", "Massive Attack");

    assert.equal(requestedUrl.searchParams.get("q"), "Teardrop Massive Attack");
    assert.equal(requestedUrl.searchParams.get("key"), "yt-key");
    assert.deepEqual(result, {
      id: "abc123DEF45",
      title: "Massive Attack - Teardrop",
      url: "https://youtube.com/watch?v=abc123DEF45",
      tags: ["trip hop"],
    });
  });

  it("returns undefined when the API result title does not mention the requested title or artist", async () => {
    global.fetch = async () =>
      jsonResponse({
        items: [
          {
            id: { videoId: "abc123DEF45" },
            snippet: { title: "Unrelated video" },
          },
        ],
      });

    const { searchURL } = await import("../src/apis/youtube.js");

    assert.equal(await searchURL("Teardrop", "Massive Attack"), undefined);
  });

  it("uses the search-page fallback on 403 and skips Shorts renderers", async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response("quota", { status: 403 });

      const shortsRenderer = {
        videoRenderer: {
          videoId: "SHORTSabc12",
          navigationEndpoint: {
            commandMetadata: {
              webCommandMetadata: { url: "/shorts/SHORTSabc12" },
            },
          },
        },
      };
      const videoRenderer = {
        videoRenderer: {
          videoId: "VIDEOabc123",
          title: { runs: [{ text: "Fallback result" }] },
        },
      };
      return new Response(
        `${JSON.stringify(shortsRenderer)}${JSON.stringify(videoRenderer)}`,
        { status: 200 },
      );
    };
    console.log = () => {};

    const { searchURL } = await import("../src/apis/youtube.js");
    const result = await searchURL("Song", "Artist");

    assert.equal(calls.length, 2);
    assert.match(calls[1], /youtube\.com\/results/);
    assert.deepEqual(result, {
      id: "VIDEOabc123",
      title: "Song Artist",
      url: "https://youtube.com/watch?v=VIDEOabc123",
      tags: undefined,
    });
  });

  it("returns null when the fallback page has only invalid, Shorts, or malformed renderers", async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response("quota", { status: 403 });

      const invalidIdRenderer = {
        videoRenderer: {
          videoId: "too-short",
          title: { simpleText: "Invalid id" },
        },
      };
      const shortsRenderer = {
        videoRenderer: {
          videoId: "VALIDshort1",
          thumbnailOverlays: [
            {
              thumbnailOverlayTimeStatusRenderer: {
                text: { simpleText: "SHORTS" },
              },
            },
          ],
        },
      };
      return new Response(
        `${JSON.stringify(invalidIdRenderer)}"videoRenderer":{"videoId":${JSON.stringify(shortsRenderer)}`,
        { status: 200 },
      );
    };
    console.log = () => {};
    console.error = () => {};

    const { searchURL } = await import("../src/apis/youtube.js");

    assert.equal(await searchURL("Song", "Artist"), null);
    assert.equal(calls.length, 2);
  });

  it("returns null when the fallback page request fails", async () => {
    const responses = [
      new Response("quota", { status: 403 }),
      new Response("blocked", { status: 503 }),
    ];
    global.fetch = async () => responses.shift();
    console.log = () => {};
    console.error = () => {};

    const { searchURL } = await import("../src/apis/youtube.js");

    assert.equal(await searchURL("Song", "Artist"), null);
  });

  it("returns null for HTTP errors and missing videos", async () => {
    const responses = [
      new Response("bad gateway", { status: 502 }),
      jsonResponse({ items: [] }),
    ];
    global.fetch = async () => responses.shift();
    console.error = () => {};

    const { searchURL } = await import("../src/apis/youtube.js");

    assert.equal(await searchURL("One", "Artist"), null);
    assert.equal(await searchURL("Two", "Artist"), null);
  });

  it("rejects calls missing title or artist before fetching", async () => {
    const { searchURL } = await import("../src/apis/youtube.js");

    await assert.rejects(() => searchURL("", "Artist"), /Title and artist required/);
  });
});
