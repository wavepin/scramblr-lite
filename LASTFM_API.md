# Last.fm API

Base URL: `https://ws.audioscrobbler.com/2.0/`

[Get Last.fm API key](https://www.last.fm/api/account/create) (need to create an account)

Every request needs `api_key=YOUR_API_KEY` and `format=json`. No authentication required for any of these endpoints.

---

## Features that rely on Last.fm:

1. **Survey** — Validate user inputs (songs, artists, albums, genres) so we only store real music data.
2. **Recommendations** — Use the survey results to find new music the user will probably like.

---

## Survey Endpoints

Let users search for and validate their favorite music.

---

### `artist.search`

**Functionality:** Searches for artists by name. Returns a list of matching artists.

**Purpose:** When a user types an artist name in the survey, this finds matching artists so they can pick the right one.

**Example request:**

```
?method=artist.search&artist=radiohead&api_key=YOUR_KEY&format=json&limit=5
```

**Params:**

- `artist` (required) — The search query
- `limit` (optional) — Max results to return

**Returns:** A list of artists with `name`, `url`, `listeners`, and `mbid`.

---

### `track.search`

**Functionality:** Searches for songs by name. Returns matching tracks with their artist.

**Purpose:** Validates song names in the survey. Users type a song and pick from the results.

**Example request:**

```
?method=track.search&track=bohemian+rhapsody&api_key=YOUR_KEY&format=json&limit=5
```

**Params:**

- `track` (required) — The search query
- `limit` (optional) — Max results to return

**Returns:** A list of tracks, each with `name`, `artist`, `url`, and `listeners`.

---

### `album.search`

**Functionality:** Searches for albums by name. Returns matching albums with their artist.

**Purpose:** Validates album names in the survey. Users type an album and pick from the results.

**Example request:**

```
?method=album.search&album=abbey+road&api_key=YOUR_KEY&format=json&limit=5
```

**Params:**

- `album` (required) — The search query
- `limit` (optional) — Max results to return

**Returns:** A list of albums, each with `name`, `artist`, and `url`.

---

### `tag.getTopTags`

**Functionality:** Returns the most popular tags (genres) on Last.fm, ordered by popularity.

**Purpose:** There's no `tag.search` endpoint. Instead, we fetch all top tags once and filter them locally to validate genre inputs from the survey.

**Example request:**

```
?method=tag.getTopTags&api_key=YOUR_KEY&format=json
```

**Params:** None beyond the API key.

**Returns:** A list of tags, each with `name`, `count`, and `reach`. Good idea to cache this because it doesn't change often.

---

## Recommendation Endpoints

Help discover new music based on what the user already likes.

---

### `artist.getSimilar`

**Functionality:** Returns artists similar to a given artist, ranked by similarity.

**Purpose:** Use for artist-based recommendations. Likes Taylor Swift -> gets Lorde, Carly Rae Jepsen, etc.

**Example request:**

```
?method=artist.getsimilar&artist=radiohead&api_key=YOUR_KEY&format=json&limit=10
```

**Params:**

- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead of name
- `limit` (optional) — Max results
- `autocorrect` (optional) — Fix misspelled names (`0` or `1`)

**Returns:** A list of similar artists, each with a `match` score from `0` (not similar) to `1` (very similar). Use the match score to weight recommendations.

---

### `track.getSimilar`

**Functionality:** Returns tracks similar to a given track, ranked by listening data.

**Purpose:** Favorite song is "Bohemian Rhapsody" -> finds songs that listeners of that track also enjoy.

**Example request:**

```
?method=track.getsimilar&artist=queen&track=bohemian+rhapsody&api_key=YOUR_KEY&format=json&limit=10
```

**Params:**

- `track` (required) — The track name
- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead
- `limit` (optional) — Max results
- `autocorrect` (optional) — Fix misspelled names

**Returns:** A list of similar tracks with `name`, `artist`, and a `match` score. Higher score = stronger recommendation.

---

### `tag.getSimilar`

**Functionality:** Returns tags (genres) similar to a given tag, ranked by similarity.

**Purpose:** Expands the user's genre preferences. Likes "disco" -> gets "funk", "soul", "dance", etc. Helps cast a wider net for recommendations.

**Example request:**

```
?method=tag.getsimilar&tag=disco&api_key=YOUR_KEY&format=json
```

**Params:**

- `tag` (required) — The tag/genre name

**Returns:** A list of related tags with `name` and `url`.

---

### `tag.getTopArtists`

**Functionality:** Returns the most popular artists for a given genre/tag.

**Purpose:** Like "indie rock" -> gives top artists in that genre. Use for genre-based recommendations.

**Example request:**

```
?method=tag.gettopartists&tag=indie+rock&api_key=YOUR_KEY&format=json&limit=10
```

**Params:**

- `tag` (required) — The genre/tag name
- `limit` (optional) — Max results (default 50)
- `page` (optional) — Page number for pagination

**Returns:** A ranked list of artists tagged with that genre, including `name`, `url`, and `mbid`.

---

### `tag.getTopTracks`

**Functionality:** Returns the most popular tracks for a given genre/tag.

**Purpose:** Recommend specific songs within the user's preferred genres (e.g. get the top "pop" tracks).

**Example request:**

```
?method=tag.gettoptracks&tag=pop&api_key=YOUR_KEY&format=json&limit=10
```

**Params:**

- `tag` (required) — The genre/tag name
- `limit` (optional) — Max results (default 50)
- `page` (optional) — Page number for pagination

**Returns:** A ranked list of tracks tagged with that genre, each with `name`, `artist`, and `url`.

---

### `tag.getTopAlbums`

**Functionality:** Returns the most popular albums for a given genre/tag.

**Purpose:** Recommend albums within the user's preferred genres. Useful if algorithm suggests full albums, not just tracks.

**Example request:**

```
?method=tag.gettopalbums&tag=rock&api_key=YOUR_KEY&format=json&limit=10
```

**Params:**

- `tag` (required) — The genre/tag name
- `limit` (optional) — Max results (default 50)
- `page` (optional) — Page number for pagination

**Returns:** A ranked list of albums tagged with that genre, each with `name`, `artist`, and `url`.

---

### `artist.getTopTags`

**Functionality:** Returns the most popular tags for a given artist, ordered by how often listeners tagged them.

**Purpose:** Builds a "taste profile" from the user's survey. If a user likes Radiohead, this tells us their tags are "alternative", "rock", "electronic", etc. Combine tags across all their favorite artists to understand their overall taste.

**Example request:**

```
?method=artist.gettoptags&artist=radiohead&api_key=YOUR_KEY&format=json
```

**Params:**

- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead
- `autocorrect` (optional) — Fix misspelled names

**Returns:** A list of tags with `name`, `count` (how many times tagged), and `url`.

---

### `track.getTopTags`

**Functionality:** Returns the most popular tags for a given track.

**Purpose:** Same idea as `artist.getTopTags` but more specific. Lets us build a detailed taste profile at the song level. A song might be tagged "melancholic", "90s", "alternative", which is richer than just the artist's genre.

**Example request:**

```
?method=track.gettoptags&artist=radiohead&track=creep&api_key=YOUR_KEY&format=json
```

**Params:**

- `track` (required) — The track name
- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead
- `autocorrect` (optional) — Fix misspelled names

**Returns:** A list of tags with `name`, `count`, and `url`.

---

### `artist.getInfo`

**Functionality:** Returns detailed metadata for an artist — bio, stats, similar artists, and tags.

**Purpose:** A "two-in-one" endpoint. One call gives the artist's tags AND similar artists, plus listener count and play count. Useful for enriching the user profile without making separate calls to `getSimilar` and `getTopTags`.

**Example request:**

```
?method=artist.getinfo&artist=Taylor+Swift&api_key=YOUR_KEY&format=json
```

**Params:**

- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead
- `autocorrect` (optional) — Fix misspelled names
- `lang` (optional) — Language for the bio (ISO 639 alpha-2 code)

**Returns:** Artist `name`, `url`, `stats` (listeners, playcount), `similar` (list of similar artists), `tags` (top tags), and `bio` (short biography).

---

### `track.getInfo`

**Functionality:** Returns detailed metadata for a track — duration, play count, album, tags, and wiki summary.

**Purpose:** Enriches song data from the survey. Get the album a track belongs to, its duration, popularity stats, and top tags in one call.

**Example request:**

```
?method=track.getinfo&artist=queen&track=bohemian+rhapsody&api_key=YOUR_KEY&format=json
```

**Params:**

- `track` (required) — The track name
- `artist` (required) — The artist name
- `mbid` (optional) — Use MusicBrainz ID instead
- `autocorrect` (optional) — Fix misspelled names

**Returns:** Track `name`, `artist`, `album`, `duration` (ms), `listeners`, `playcount`, `toptags`, and `wiki`.

---

## Recommendations Algorithm

Using survey results to build recommendations:

| Survey field     | Step 1: Build taste profile                 | Step 2: Find recommendations                                     |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Favorite artists | `artist.getTopTags` → extract genre weights | `artist.getSimilar` → find similar artists                       |
| Favorite songs   | `track.getTopTags` → extract genre weights  | `track.getSimilar` → find similar tracks                         |
| Favorite genres  | Already a genre to use directly             | `tag.getTopArtists` / `tag.getTopTracks` → top content per genre |

**Basic flow:**

1. User submits survey → saved to Firebase
2. For each artist/song, call `getTopTags` to build a weighted genre map
3. Merge with the user's explicit genre picks
4. Call `getSimilar` on each artist/song for direct recommendations
5. Call `tag.getTopArtists`/`tag.getTopTracks` for genre-based discovery
6. Score, deduplicate, and rank results
