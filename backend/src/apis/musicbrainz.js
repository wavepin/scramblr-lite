export{searchArtists, searchSongs}

const API_URL = 'https://musicbrainz.org/ws/2';

/* This function queries a string for an artist name and returns an array of artists in json
 The array is structureed as follows: index: {
    id: string, //musicbrainz id for the artist
    name: string, //artist name
    country: string //artist country of origin, if available}*/ 
async function searchArtists(query) {
try{const url = `${API_URL}/artist?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
  const response = await fetch(url, {
    headers: { "User-Agent": "scramblr/.1 (tdor@umass.edu)" }//musicbrainz requires a user agent for API requests, so we include an email address and app name in the headers
  });
  if(!response.ok){
    throw new Error(`HTTP error status: ${response.status}`);
  }
  const data = await response.json();
  if(!data.artists || data.artists.length == 0){return [];}
    return data.artists.map(artist => ({ //using musicbrainz, we can add more fields here if needed
      id: artist.id,
      name: artist.name,
      country: artist.country || 'Unknown'      
    }));
} catch (error){
    console.error('Error fetching artists:', error);
    return [];
};
}
/* This function queries a string for an artist name and returns an array of music in json
The array is structured as follows: index: {
    id: string, //musicbrainz id for the recording
    name: string, //song title
    artist: string //artist name, if available}
    artistId: string //musicbrainz id for the artist, if available */
async function searchSongs(query){
    try { //url limits api call to 10, formats in json, and includes genres and tags for each recording(although I'm not sure if this part is working)
        const url = `${API_URL}/recording?query=${encodeURIComponent(query)}&limit=10&fmt=json&inc=genres+tags`;
        const response = await fetch(url, {
            headers: { "User-Agent": "scramblr/.1 (tdor@umass.edu)" }
        });
        if(!response.ok){
            throw new Error(`HTTP error status: ${response.status}`);
        }
        const data = await response.json();
        if(!data.recordings || data.recordings.length == 0){return [];} //checks if result isn't empty then maps it to expected format
        return data.recordings.map(recording => ({
            id: recording.id,
            name: recording.title,
            artist: recording['artist-credit']?.[0]?.name || 'Unknown', //only adds first listed artist, song queries may have multiple but I don't want to deal with that right now
            artistId: recording['artist-credit']?.[0]?.artist?.id || null,
            genres: recording.genres ? recording.genres.map(genre => genre.name) : [], //for some reason most api calls returns null, so we may need to find another way to find the genre of the song
            length: recording.length                                                   
        }));
    } catch (error) {
        console.error('Error fetching songs:', error);
        return [];
    }
}
async function getArtistById(id) {} //to be implemented

