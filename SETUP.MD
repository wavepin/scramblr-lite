# Local setup

This guide sets up [wavepin/scramblr-lite](https://github.com/wavepin/scramblr-lite) with three local processes: the React frontend, the Express API, and the FastAPI recommendation service. You must supply your own API credentials, Firebase project, and populated Qdrant collection.

## 1. Prepare dependencies and services

Install Git, Node.js 24 LTS with npm, Python, and FFmpeg. The Python source requires Python 3.10+ syntax; use a Python version with compatible wheels for PyTorch, Transformers, NumPy, and librosa. Python dependencies are unpinned, so use an isolated virtual environment.

Confirm the tools are available:

```bash
git --version
node --version
npm --version
python3 --version
ffmpeg -version
ffprobe -version
```

Install FFmpeg with your platform's package manager or a platform-appropriate distribution. Record the absolute directory containing `ffmpeg` and `ffprobe` for `FFMPEG_PATH`.

Prepare these services before starting the app:

| Service | Required configuration |
| --- | --- |
| Last.fm | Your API key for search, tags, and representative tracks |
| YouTube Data API v3 | An API key from your own Google Cloud project with that API enabled |
| Qdrant | Your cluster URL, API key, and a populated collection of compatible 512-dimensional CLAP audio vectors |
| Firebase | Your web-app configuration, email/password authentication, Firestore, authorized development domains, and user-scoped security rules |
| OpenAI | Your API key with access to `gpt-4o-mini` for artist biographies and genre labels |

The repository does not include a vector database export, model weights, or deployed Firebase rules. The song lists under `scraper/` are inventories, not a populated vector collection. The model service downloads `laion/larger_clap_music` on first startup and uses CUDA when available, otherwise CPU. Allow disk space and time for dependency installation and model loading.

## 2. Clone this repository

```bash
git clone https://github.com/wavepin/scramblr-lite.git
cd scramblr-lite
```

Run the remaining commands from this directory unless a step explicitly changes it. The commands below use a Bash-compatible shell on macOS or Linux. On Windows with Git Bash, use `python` instead of `python3` if that is your Python executable, and activate the virtual environment with `source .venv/Scripts/activate` instead of `source .venv/bin/activate`.

## 3. Install application dependencies

```bash
npm ci --prefix backend
npm ci --prefix frontend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
```

The root package does not start the application. Install the backend and frontend packages separately as shown above.

## 4. Configure the backend and model service

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` using the following settings. Fill every empty value with your own configuration; the empty assignments below are placeholders, not usable defaults.

```dotenv
LASTFM_API_KEY=
YOUTUBE_API_KEY=
QDRANT_API_KEY=
QDRANT_COLLECTION_NAME=
FFMPEG_PATH=
URL_BASE=http://localhost:3001/
OPENAI_API_KEY=
MODEL_SERVICE_URL=http://127.0.0.1:8000
UUID_NAMESPACE=
```

| Setting | What to enter |
| --- | --- |
| `LASTFM_API_KEY` | Your Last.fm API key |
| `YOUTUBE_API_KEY` | Your YouTube Data API v3 key |
| `QDRANT_API_KEY` | Your cluster key with permission to read/write vectors and create the required payload indexes |
| `QDRANT_COLLECTION_NAME` | The exact name of your populated collection; do not leave this empty when running the app |
| `FFMPEG_PATH` | Absolute directory containing FFmpeg and ffprobe; quote the value if its path contains spaces |
| `URL_BASE` | The Express URL used by preference audio resolution; retain the local value above |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `MODEL_SERVICE_URL` | The model-service URL used by Express; use the value above without a trailing slash |
| `UUID_NAMESPACE` | A valid UUID used to derive stable Qdrant point IDs |

The checked-in example has an extra colon in `MODEL_SERVICE_URL`. Replace that value with `http://127.0.0.1:8000` as shown above.

For a new collection, generate a namespace once:

```bash
python -c 'import uuid; print(uuid.uuid4())'
```

Copy the result into `UUID_NAMESPACE` and retain it for that collection. When using an existing collection, use its namespace if one was established. This value must be present before FastAPI starts because the recommendation modules parse it during import.

Express and the FastAPI entry point both load `backend/.env`. Express calls the running FastAPI service over HTTP; it does not start Python for you. Keep `backend/.env` local and do not commit credentials.

### Configure your Qdrant endpoint and collection

The cluster URL is currently hardcoded in Python; adding `QDRANT_URL` to `.env` does not override it. Replace the `QDRANT_URL` constants with your own cluster endpoint in:

- `backend/src/model_service.py`
- `backend/recommendation_algorithm/get_vector_from_preferences.py`
- `backend/recommendation_algorithm/recommend.py`
- `backend/recommendation_algorithm/recommend_playlist.py`
- `backend/recommendation_algorithm/update_vector_from_interactions.py`

The standalone experiment `backend/recommendation_algorithm/test.py` has its own cluster URL and collection constant. Configure those separately only if you intend to run that experiment; it is not part of normal startup or the unit suite.

The application expects compatible 512-dimensional audio embeddings and payloads containing song titles and artists, with tags and playback metadata where available. It looks up the `song` and `artist` fields through text indexes and may insert newly resolved vectors. Provision the collection and populate it before running discovery; a fresh empty collection is not a usable recommendation catalog.

Keep Express on port `3001` for these instructions. The playlist resolver also has a fixed `http://localhost:3001/` callback URL, and the frontend's Vite proxy targets port `3001`; changing only `URL_BASE` does not update those settings.

## 5. Configure Firebase

In your Firebase project, register a web app and copy its configuration. Replace all six placeholder strings in [`frontend/src/firebase.js`](frontend/src/firebase.js):

| Field | Placeholder to replace |
| --- | --- |
| `apiKey` | `YOUR_FIREBASE_API_KEY` |
| `authDomain` | `YOUR_FIREBASE_AUTH_DOMAIN` |
| `projectId` | `YOUR_FIREBASE_PROJECT_ID` |
| `storageBucket` | `YOUR_FIREBASE_STORAGE_BUCKET` |
| `messagingSenderId` | `YOUR_FIREBASE_MESSAGING_SENDER_ID` |
| `appId` | `YOUR_FIREBASE_APP_ID` |

Enable email/password sign-in, create the Firestore database, and configure the development hostname you use, such as `localhost`, in Authentication's authorized domains. Deploy Firestore rules restricting access to the authenticated user's documents under `users/{uid}` and the preferences, queue, listening history, and playlist subcollections described in the [README](README.md#state-and-persistence). Create any additional indexes requested by Firestore when exercising the app's queries.

These frontend values are separate from `backend/.env`; the application does not read Firebase configuration from backend environment variables. No working Firebase configuration is included. Keep your configured values local and do not commit them.

## 6. Start the three processes

Open three terminals, each initially in the repository root.

**Terminal 1 — FastAPI model service**

```bash
source .venv/bin/activate
cd backend
python -m uvicorn src.model_service:app --host 127.0.0.1 --port 8000
```

Do not add multiple workers for this local setup: each worker loads its own model. Wait for startup to finish. The service's generated API documentation is available at [127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

**Terminal 2 — Express API**

```bash
cd backend
npm start
```

Express listens on port `3001`. Keep this process running for model-service video lookup callbacks as well as browser API requests.

**Terminal 3 — React development server**

```bash
cd frontend
npm run dev -- --host localhost --port 5173 --strictPort
```

Open [localhost:5173](http://localhost:5173). Vite forwards `/api` requests to Express. Create an account and complete all four survey groups: liked songs, liked artists, liked genres, and avoided genres. The current preference service requires each group to be nonempty. Then check discovery, playback, reactions, listening history, and playlist generation with your configured services.

Stop each process with `Ctrl+C` in its terminal.

### Optional startup helpers

- **macOS:** `bash run-local-mac.sh` starts Express and Vite only. Start FastAPI separately using Terminal 1's command.
- **Windows with Git Bash:** activate `.venv/Scripts/activate`, then run `bash run-local.sh` from the repository root. This script starts all three processes and expects `node.exe`, `python.exe`, and `powershell.exe` on `PATH`. Its optional `MODEL_SERVICE_HOST` and `MODEL_SERVICE_PORT` shell variables override the host and port derived from `MODEL_SERVICE_URL`; keep them consistent with that URL.
- **Linux or WSL with Linux executables:** use the three manual commands; the Windows helper requires Windows executables.

The helpers terminate processes on their development ports during startup or cleanup. Use the manual commands if other applications share those ports.

## 7. Run checks

From the repository root:

```bash
npm test --prefix backend
npm run lint --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

On native Windows, the backend test script's `NODE_ENV=test` assignment may not work with npm's default command shell. In Git Bash, run its equivalent directly:

```bash
cd backend
NODE_ENV=test node --test
cd ..
```

For the focused Python suite, activate the virtual environment and run:

```bash
python -m pip install pytest
python -m pytest backend/recommendation_algorithm/test_recommend.py -q
```

The Python suite uses mocked model/database dependencies. The separate `backend/recommendation_algorithm/test.py` experiment uses live services and is not required for verification. Existing lint errors in `backend/src/apis/musicbrainz.js` and `frontend/src/pages/Activity.jsx`, and the frontend build's large-chunk warning, are documented in the [README](README.md#verification).

A successful build writes `frontend/dist`; it does not start Express or FastAPI, configure cloud services, or validate live music playback.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Firebase initialization or sign-in fails | Replace every Firebase placeholder; check the project, enabled sign-in provider, and authorized hostname |
| Firestore reports insufficient permissions | Deploy rules matching the authenticated UID and the app's document paths |
| FastAPI fails while importing a recommendation module | Set a valid `UUID_NAMESPACE` and install compatible Python dependencies in the activated environment |
| Express cannot reach the model service | Start FastAPI and correct `MODEL_SERVICE_URL`, including the example's extra colon |
| Qdrant connection or collection lookup fails | Update the hardcoded cluster URLs, provide the correct key, and fill `QDRANT_COLLECTION_NAME` |
| No useful recommendations are available | Confirm that the collection is populated with compatible embeddings and song/artist payloads |
| Missing endpoint audio cannot be processed | Verify `FFMPEG_PATH`, ffprobe availability, and the provider response |
| Video lookup, biographies, or genres fail | Check the relevant API key, service access, quota, and network connectivity |
| Port `5173` is occupied | Stop the conflicting development process or deliberately choose another frontend port |
