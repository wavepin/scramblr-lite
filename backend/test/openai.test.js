import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

async function readRequestBody(input, init) {
  if (init?.body) return JSON.parse(init.body);
  if (input instanceof Request) return JSON.parse(await input.clone().text());
  throw new Error("No request body found");
}

describe("OpenAI API helper", () => {
  it("requests a concise artist bio and caches repeat artists", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const requestBodies = [];
    global.fetch = async (input, init) => {
      requestBodies.push(await readRequestBody(input, init));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Kate Bush is an English singer, songwriter, and producer.",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const { getArtistBio } = await import(`../src/apis/openai.js?test=${Date.now()}`);

    assert.equal(
      await getArtistBio("Kate Bush"),
      "Kate Bush is an English singer, songwriter, and producer.",
    );
    assert.equal(
      await getArtistBio("Kate Bush"),
      "Kate Bush is an English singer, songwriter, and producer.",
    );
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "gpt-4o-mini");
    assert.equal(requestBodies[0].max_tokens, 120);
    assert.match(requestBodies[0].messages[0].content, /Kate Bush/);
  });

  it("keeps separate cache entries for different artists", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const promptedArtists = [];
    global.fetch = async (input, init) => {
      const body = await readRequestBody(input, init);
      const artist = body.messages[0].content.match(/"([^"]+)"/)[1];
      promptedArtists.push(artist);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: ` Bio for ${artist}. `,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const { getArtistBio } = await import(`../src/apis/openai.js?test=${Date.now()}-artists`);

    assert.equal(await getArtistBio("Björk"), "Bio for Björk.");
    assert.equal(await getArtistBio("FKA twigs"), "Bio for FKA twigs.");
    assert.equal(await getArtistBio("Björk"), "Bio for Björk.");
    assert.deepEqual(promptedArtists, ["Björk", "FKA twigs"]);
  });
});
