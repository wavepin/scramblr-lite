import OpenAI from "openai";

// In-memory cache so the same artist is never called twice per server session
const bioCache = new Map();
const genreCache = new Map();
let client = null;

export async function getTrackGenre(title, artist, allowedGenres = []) {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const key = `${title}||${artist}`;
  if (genreCache.has(key)) return genreCache.get(key);

  const genreList = allowedGenres.join(", ");
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `From this list of genres: ${genreList}\n\nWhich single genre best fits the song "${title}" by "${artist}"? Reply with only the genre name exactly as it appears in the list, nothing else.`,
      },
    ],
    max_tokens: 20,
  });

  const genre = completion.choices[0].message.content.trim();
  genreCache.set(key, genre);
  return genre;
}

export async function getArtistBio(artist) {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (bioCache.has(artist)) return bioCache.get(artist);

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Write a 1-2 sentence bio for the music artist "${artist}". Be factual and concise focusing on information about the artist generally, rather than specific songs, include any awards/accolades.  No markdown, plain text only. Answer in English`,
      },
    ],
    max_tokens: 120,
  });

  const bio = completion.choices[0].message.content.trim();
  bioCache.set(artist, bio);
  return bio;
}
