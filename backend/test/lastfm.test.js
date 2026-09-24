import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const originalFetch = global.fetch;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
  delete process.env.LASTFM_API_KEY;
});

async function importLastfm() {
  return import(`../src/apis/lastfm.js?test=${Date.now()}-${Math.random()}`);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Last.fm API helpers", () => {
  it("searchArtists maps Last.fm artist matches to compact results", async () => {
    process.env.LASTFM_API_KEY = "lastfm-key";
    const calls = [];
    global.fetch = async (url) => {
      const parsed = new URL(url);
      calls.push(Object.fromEntries(parsed.searchParams));
      return jsonResponse({
        results: {
          artistmatches: {
            artist: [
              { name: "Radiohead", url: "https://last.fm/radiohead", mbid: "abc" },
              { name: "Radio Dept.", url: "https://last.fm/radio-dept" },
            ],
          },
        },
      });
    };

    const { searchArtists } = await importLastfm();
    const results = await searchArtists("radio");

    assert.deepEqual(calls[0], {
      api_key: "lastfm-key",
      format: "json",
      method: "artist.search",
      artist: "radio",
      limit: "5",
    });
    assert.deepEqual(results, [
      { name: "Radiohead", url: "https://last.fm/radiohead", mbid: "abc" },
      { name: "Radio Dept.", url: "https://last.fm/radio-dept", mbid: null },
    ]);
  });

  it("searchTracks and searchAlbums return empty arrays when Last.fm returns no matches", async () => {
    global.fetch = async () => jsonResponse({ results: {} });

    const { searchTracks, searchAlbums } = await importLastfm();
    console.log = () => {};

    assert.deepEqual(await searchTracks("missing"), []);
    assert.deepEqual(await searchAlbums("missing"), []);
  });

  it("searchTracks maps matches and defaults missing artists to Unknown", async () => {
    global.fetch = async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("method"), "track.search");
      assert.equal(parsed.searchParams.get("track"), "roads");
      assert.equal(parsed.searchParams.get("limit"), "5");
      return jsonResponse({
        results: {
          trackmatches: {
            track: [
              { name: "Roads", artist: "Portishead", url: "https://last.fm/roads" },
              { name: "Roads live", url: "https://last.fm/roads-live" },
            ],
          },
        },
      });
    };
    console.log = () => {};

    const { searchTracks } = await importLastfm();

    assert.deepEqual(await searchTracks("roads"), [
      { name: "Roads", artist: "Portishead", url: "https://last.fm/roads" },
      { name: "Roads live", artist: "Unknown", url: "https://last.fm/roads-live" },
    ]);
  });

  it("searchAlbums maps matches and defaults missing artists to Unknown", async () => {
    global.fetch = async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("method"), "album.search");
      assert.equal(parsed.searchParams.get("album"), "dummy");
      assert.equal(parsed.searchParams.get("limit"), "5");
      return jsonResponse({
        results: {
          albummatches: {
            album: [
              { name: "Dummy", artist: "Portishead", url: "https://last.fm/dummy" },
              { name: "Dummy Remixes", url: "https://last.fm/dummy-remixes" },
            ],
          },
        },
      });
    };

    const { searchAlbums } = await importLastfm();

    assert.deepEqual(await searchAlbums("dummy"), [
      { name: "Dummy", artist: "Portishead", url: "https://last.fm/dummy" },
      { name: "Dummy Remixes", artist: "Unknown", url: "https://last.fm/dummy-remixes" },
    ]);
  });

  it("searchGenres filters cached top tags without a second network call", async () => {
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      return jsonResponse({
        toptags: {
          tag: [
            { name: "rock" },
            { name: "indie rock" },
            { name: "jazz" },
            { name: "post-rock" },
            { name: "pop" },
            { name: "classic rock" },
          ],
        },
      });
    };

    const { getTopTags, searchGenres } = await importLastfm();

    assert.equal((await getTopTags()).length, 6);
    assert.deepEqual(await searchGenres("ROCK"), [
      { name: "rock" },
      { name: "indie rock" },
      { name: "post-rock" },
      { name: "classic rock" },
    ]);
    assert.equal(fetchCount, 1);
  });

  it("getTrackTopTags returns the top tag or Unknown on empty/error responses", async () => {
    const responses = [
      jsonResponse({ toptags: { tag: [{ name: "dream pop" }, { name: "shoegaze" }] } }),
      jsonResponse({ toptags: { tag: [] } }),
      new Response("nope", { status: 500 }),
    ];
    global.fetch = async () => responses.shift();
    console.error = () => {};

    const { getTrackTopTags } = await importLastfm();

    assert.equal(await getTrackTopTags("Cocteau Twins", "Cherry-coloured Funk"), "dream pop");
    assert.equal(await getTrackTopTags("Nobody", "Nothing"), "Unknown");
    assert.equal(await getTrackTopTags("Nobody", "Error"), "Unknown");
  });

  it("search helpers swallow Last.fm HTTP errors and return empty results", async () => {
    global.fetch = async () => new Response("rate limited", { status: 429 });
    console.error = () => {};

    const { searchArtists, searchTracks, searchAlbums, getTopTags } = await importLastfm();
    console.log = () => {};

    assert.deepEqual(await searchArtists("x"), []);
    assert.deepEqual(await searchTracks("x"), []);
    assert.deepEqual(await searchAlbums("x"), []);
    assert.deepEqual(await getTopTags(), []);
  });

  it("top-track helpers normalize singleton track responses into arrays", async () => {
    const responses = [
      jsonResponse({ toptracks: { track: { name: "One", artist: { name: "A" } } } }),
      jsonResponse({ tracks: { track: { name: "Two", artist: { name: "B" } } } }),
    ];
    global.fetch = async () => responses.shift();

    const { getArtistTopTracks, getTagTopTracks } = await importLastfm();

    assert.deepEqual(await getArtistTopTracks("A"), [{ name: "One", artist: { name: "A" } }]);
    assert.deepEqual(await getTagTopTracks("rock"), [{ name: "Two", artist: { name: "B" } }]);
  });
});
