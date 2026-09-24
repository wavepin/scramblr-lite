import requests
import time

API_KEY = "YOUR_LASTFM_API_KEY_HERE"
BASE_URL = "https://ws.audioscrobbler.com/2.0/"
INPUT_FILE = "scraper/billboard_songs.txt"
OUTPUT_FILE = "scraper/similar_songs.txt"
SIMILAR_LIMIT = 5
ARTIST_CAP = 2
 
 
def get_similar_songs(artist, title):
    params = {
        "method": "track.getSimilar",
        "artist": artist,
        "track": title,
        "limit": SIMILAR_LIMIT,
        "autocorrect": 1,
        "api_key": API_KEY,
        "format": "json"
    }
    try:
        r = requests.get(BASE_URL, params=params, timeout=10)
        data = r.json()
        tracks = data.get("similartracks", {}).get("track", [])
        return [(t["artist"]["name"], t["name"]) for t in tracks]
    except Exception as e:
        print(f"  Error fetching similar for {artist} - {title}: {e}")
        return []
 
 
def main():
    with open(INPUT_FILE, "r") as f:
        lines = [l.strip() for l in f if " - " in l.strip()]
 
    billboard_set = set(l.lower() for l in lines)
    similar_set = set()
    artist_count = {}
 
    print(f"Fetching similar songs for {len(lines)} billboard tracks...\n")
 
    for line in lines:
        artist, title = line.split(" - ", 1)
        artist, title = artist.strip(), title.strip()
        print(f"Processing: {artist} - {title}")
 
        added = 0
        similar = get_similar_songs(artist, title)
 
        if not similar:
            print(f"  No results from Last.fm")
        else:
            for s_artist, s_title in similar:
                entry = f"{s_artist} - {s_title}"
                entry_lower = entry.lower()
                artist_key = s_artist.lower()
 
                if (entry_lower not in billboard_set and
                        entry_lower not in similar_set and
                        artist_count.get(artist_key, 0) < ARTIST_CAP):
                    similar_set.add(entry_lower)
                    artist_count[artist_key] = artist_count.get(artist_key, 0) + 1
                    added += 1
 
            print(f"  Got {len(similar)} from Last.fm, {added} new after dedup/cap")
 
        time.sleep(0.2)
 
    with open(OUTPUT_FILE, "w") as f:
        for song in sorted(similar_set):
            f.write(song + "\n")
 
    print(f"\nDone! {len(similar_set)} unique similar songs saved to {OUTPUT_FILE}")
 
 
if __name__ == "__main__":
    main()
