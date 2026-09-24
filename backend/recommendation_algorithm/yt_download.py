import os
import yt_dlp
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# --- CONFIGURATION ---
SCOPES = ['https://www.googleapis.com/auth/drive.file']
LINKS_FILE = 'song_url2.txt'
DRIVE_FOLDER_ID = '1E6Djrqt4SgldMGiy0IYR2y9ED01YpTas' # Found in the URL of your Drive folder

def get_drive_service():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    return build('drive', 'v3', credentials=creds)

def upload_to_drive(service, file_path, folder_id):
    file_metadata = {
        'name': os.path.basename(file_path),
        'parents': [folder_id]
    }
    media = MediaFileUpload(file_path, mimetype='audio/mpeg')
    file = service.files().create(body=file_metadata, media_body=media, fields='id').execute()
    print(f"Uploaded: {file_metadata['name']} (ID: {file.get('id')})")

def download_and_upload():
    service = get_drive_service()
    
    ydl_opts = {
        'format': 'bestaudio/best',
        # Paste your full WinGet path here, ending at the \bin folder
        'ffmpeg_location': r'C:\Users\Bruce\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'outtmpl': '%(title)s.%(ext)s',
    }

    if not os.path.exists(LINKS_FILE):
        print(f"Error: {LINKS_FILE} not found.")
        return

    with open(LINKS_FILE, 'r') as f:
        urls = [line.strip() for line in f if line.strip()]

    for url in urls:
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(info).replace('.webm', '.mp3').replace('.m4a', '.mp3')
                
                upload_to_drive(service, filename, DRIVE_FOLDER_ID)
            
                os.remove(filename)
        except Exception as e:
            print(f"Failed to process {url}: {e}")

if __name__ == "__main__":
    download_and_upload()