"""Explicit local attachment snapshots and a separate, revision-bound Gemma index.

This library does not scan folders, record devices, grant admission or generate
captions. A trusted caller must select approved files and supervise inference.
"""
import hashlib
from contextlib import contextmanager
import io
import math
import os
import re
from pathlib import Path
import sqlite3
import stat
import struct
import tempfile
import time
import wave

MODEL = 'google/embeddinggemma-2'
REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'
DIMENSIONS = 768
LIMIT = 32 * 1024 * 1024


def ordinary(path, directory=False):
    path = Path(path)
    for parent in (path, *path.parents):
        row = parent.lstat()
        if getattr(row, 'st_file_attributes', 0) & 0x400 or stat.S_ISLNK(row.st_mode):
            raise ValueError('Media paths must not traverse reparse points.')
    row = path.stat()
    if directory and not stat.S_ISDIR(row.st_mode):
        raise ValueError('Media root must be an ordinary directory.')
    if not directory and (not stat.S_ISREG(row.st_mode) or row.st_nlink != 1):
        raise ValueError('Media must be an ordinary single-link file.')
    return row


def read(path):
    before = ordinary(path)
    if not 0 < before.st_size <= LIMIT:
        raise ValueError('Media exceeds the 32 MiB snapshot bound.')
    with Path(path).open('rb') as file:
        raw = file.read(LIMIT + 1)
    after = ordinary(path)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or len(raw) != before.st_size:
        raise ValueError('Media changed during snapshot reading.')
    return raw


def format(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image', '.png'
    if raw.startswith(b'\xff\xd8\xff'):
        return 'image', '.jpg'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WAVE':
        return 'audio', '.wav'
    if raw[:4] == b'RIFF' and raw[8:12] == b'AVI ':
        return 'video', '.avi'
    if raw[4:8] == b'ftyp':
        return 'video', '.mp4'
    raise ValueError('Unsupported media signature; use PNG, JPEG, WAV, AVI or MP4.')


def vector(value):
    if not isinstance(value, list) or len(value) != DIMENSIONS or any(type(item) not in (int, float) or not math.isfinite(item) for item in value):
        raise ValueError('Expected a finite 768-dimensional media embedding.')
    raw = struct.pack('<' + 'f' * DIMENSIONS, *value)
    values = struct.unpack('<' + 'f' * DIMENSIONS, raw)
    if abs(math.sqrt(sum(item * item for item in values)) - 1) > 0.001:
        raise ValueError('Media embeddings must be normalized.')
    return raw


def inspect(path):
    """Decode an immutable byte snapshot under pilot bounds; no recording/inference.

    Native decoder calls still require an externally owned process deadline.
    """
    raw = read(path)
    kind, _ = format(raw)
    result = dict(kind=kind, sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
    if kind == 'image':
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            if width * height > 4_194_304 or max(width, height) > 4096 or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Image exceeds the single-frame 4 megapixel pilot bound.')
            image.load()
        return dict(result, width=width, height=height, segments=[])
    if kind == 'audio':
        with wave.open(io.BytesIO(raw), 'rb') as audio:
            rate, frames = audio.getframerate(), audio.getnframes()
            if rate != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != 'NONE':
                raise ValueError('Pilot audio requires mono 16 kHz PCM16 WAV.')
            duration = frames / rate
            if not 0 < duration <= 60:
                raise ValueError('Audio exceeds the 60-second pilot bound.')
            if len(audio.readframes(frames + 1)) != frames * 2:
                raise ValueError('Audio frame count differs from its header.')
        return dict(result, duration=duration, segments=[dict(start=start / rate, end=min(start + 30 * rate, frames) / rate) for start in range(0, frames, 30 * rate)])
    import av
    stamp = time.monotonic()
    with av.open(io.BytesIO(raw)) as container:
        streams = list(container.streams.video)
        if len(streams) != 1 or len(container.streams.audio) > 1:
            raise ValueError('Pilot video requires one video stream and at most one audio stream.')
        stream = streams[0]
        if stream.width * stream.height > 4_194_304 or max(stream.width, stream.height) > 4096:
            raise ValueError('Video frame exceeds the 4 megapixel pilot bound.')
        if stream.duration is None or stream.time_base is None:
            raise ValueError('Video requires a declared duration and time base.')
        duration = float(stream.duration * stream.time_base)
        if not math.isfinite(duration) or not 0 < duration <= 30:
            raise ValueError('Video exceeds the 30-second pilot bound.')
        segments = []
        previous = -1
        for count, frame in enumerate(container.decode(stream)):
            if count >= 1800 or time.monotonic() - stamp > 10:
                raise ValueError('Video decoding exceeds its frame or time bound.')
            if frame.width * frame.height > 4_194_304 or max(frame.width, frame.height) > 4096:
                raise ValueError('Video frame exceeds the 4 megapixel pilot bound.')
            if frame.pts is None or frame.time_base is None:
                raise ValueError('Video frame has no timestamp.')
            point = float(frame.pts * frame.time_base)
            if not math.isfinite(point) or not 0 <= point < duration:
                raise ValueError('Video frame timestamp lies outside its duration.')
            if point < previous:
                raise ValueError('Video timestamps are not monotonic.')
            if not segments or point >= segments[-1]['start'] + 1:
                segments.append(dict(start=point, end=min(point + 1, duration)))
            previous = point
        if not segments:
            raise ValueError('Video contains no decoded frames.')
        tracks = len(container.streams.audio)
    return dict(result, duration=duration, segments=segments, audio_streams=tracks)


class Library:
    def __init__(self, root):
        self.root = Path(root).absolute()
        ordinary(self.root, directory=True)
        self.assets = self.root / 'Assets'
        self.assets.mkdir(exist_ok=True)
        ordinary(self.assets, directory=True)
        self.path = self.root / ('gemma2-' + REVISION + '.sqlite')
        if self.path.exists():
            ordinary(self.path)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            expected = {'model': MODEL, 'revision': REVISION, 'dimensions': str(DIMENSIONS)}
            current = dict(db.execute('SELECT key,value FROM meta'))
            if current and current != expected:
                raise ValueError('Media index belongs to a different embedding space.')
            db.executemany('INSERT OR IGNORE INTO meta VALUES (?,?)', expected.items())
            db.execute('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, relative TEXT NOT NULL, sha256 TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL, imported REAL NOT NULL, vector BLOB)')
            db.execute('CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY, removed REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS segments (id TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(id,start,end))')

    @contextmanager
    def connect(self):
        ordinary(self.root, directory=True)
        ordinary(self.assets, directory=True)
        if self.path.exists():
            ordinary(self.path)
        db = sqlite3.connect(self.path)
        try:
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
                expected = {'model': MODEL, 'revision': REVISION, 'dimensions': str(DIMENSIONS)}
                if dict(db.execute('SELECT key,value FROM meta')) != expected:
                    raise ValueError('Media index embedding space changed.')
            with db:
                yield db
        finally:
            db.close()

    def add(self, path, title):
        if not isinstance(title, str) or not title.strip() or len(title) > 200 or any(ord(item) < 32 for item in title):
            raise ValueError('Supply a short nonempty attachment title.')
        source = Path(path).absolute()
        raw = read(source)
        kind, suffix = format(raw)
        digest = hashlib.sha256(raw).hexdigest()
        relative = 'Assets/' + digest + suffix
        target = self.root / relative
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM items JOIN tombstones USING(id) WHERE id=?', (digest,)).fetchone():
                raise ValueError('Attachment cleanup is pending; retry forgetting before re-import.')
            if db.execute('SELECT COUNT(*) FROM items').fetchone()[0] >= 128 and not db.execute('SELECT 1 FROM items WHERE id=?', (digest,)).fetchone():
                raise ValueError('Pilot media library exceeds 128 attachments.')
            if target.exists():
                if read(target) != raw:
                    raise ValueError('An existing attachment snapshot differs.')
            else:
                with tempfile.NamedTemporaryFile(dir=self.assets, prefix='.snapshot-', delete=False) as file:
                    pending = Path(file.name)
                    try:
                        file.write(raw)
                        file.flush()
                        os.fsync(file.fileno())
                    except BaseException:
                        file.close()
                        pending.unlink()
                        raise
                try:
                    os.link(pending, target)
                except FileExistsError:
                    if read(target) != raw:
                        raise ValueError('An existing attachment snapshot differs.')
                finally:
                    pending.unlink()
            ordinary(target)
            db.execute('INSERT INTO items VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET title=excluded.title',
                       (digest, kind, relative, digest, title.strip(), str(source), time.time()))
            db.execute('DELETE FROM tombstones WHERE id=?', (digest,))
        return self.item(digest)

    def record(self, key):
        with self.connect() as db:
            row = db.execute('SELECT id,kind,relative,sha256,title,origin,imported FROM items WHERE id=?', (key,)).fetchone()
        if row is None:
            raise ValueError('Attachment is absent or forgotten.')
        value = dict(zip(('id', 'kind', 'relative', 'sha256', 'title', 'origin', 'imported'), row))
        suffix = Path(value['relative']).suffix
        kinds = {'image': {'.png', '.jpg'}, 'audio': {'.wav'}, 'video': {'.avi', '.mp4'}}
        if not re.fullmatch('[a-f0-9]{64}', value['id']) or suffix not in kinds.get(value['kind'], set()) or value['relative'] != 'Assets/' + value['id'] + suffix or value['id'] != value['sha256']:
            raise ValueError('Attachment address differs from its content identity.')
        return value

    def item(self, key):
        value = self.record(key)
        with self.connect() as db:
            if db.execute('SELECT 1 FROM tombstones WHERE id=?', (key,)).fetchone():
                raise ValueError('Attachment is absent or forgotten.')
        raw = read(self.root / value['relative'])
        if hashlib.sha256(raw).hexdigest() != value['sha256'] or format(raw)[0] != value['kind']:
            raise ValueError('Attachment snapshot changed; import the new revision.')
        return value

    def inventory(self):
        with self.connect() as db:
            keys = [row[0] for row in db.execute('SELECT id FROM items WHERE id NOT IN (SELECT id FROM tombstones) ORDER BY id')]
        if len(keys) > 128:
            raise ValueError('Pilot media library exceeds 128 attachments.')
        return [self.item(key) for key in keys]

    def publish(self, rows, space):
        if not isinstance(space, dict) or type(space.get('dimensions')) is not int or space != {'model': MODEL, 'revision': REVISION, 'dimensions': DIMENSIONS}:
            raise ValueError('Media embeddings belong to a different model space.')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 128:
            raise ValueError('Supply a bounded batch of media embeddings.')
        values = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'id', 'sha256', 'vector'} or row['id'] in seen:
                raise ValueError('Malformed or duplicate media embedding row.')
            item = self.item(row['id'])
            if item['sha256'] != row['sha256']:
                raise ValueError('Embedding source revision differs.')
            values.append((vector(row['vector']), item['id']))
            seen.add(item['id'])
        with self.connect() as db:
            for raw, key in values:
                self.item(key)
                if db.execute('UPDATE items SET vector=? WHERE id=?', (raw, key)).rowcount != 1:
                    raise ValueError('Attachment was removed during indexing.')

    def search(self, query, space, top=5):
        if not isinstance(space, dict) or type(space.get('dimensions')) is not int or space != {'model': MODEL, 'revision': REVISION, 'dimensions': DIMENSIONS}:
            raise ValueError('Query belongs to a different embedding space.')
        if type(top) is not int or not 1 <= top <= 10:
            raise ValueError('Media search top must be from one to ten.')
        query = struct.unpack('<' + 'f' * DIMENSIONS, vector(query))
        with self.connect() as db:
            rows = list(db.execute('SELECT id,vector FROM items WHERE vector IS NOT NULL AND id NOT IN (SELECT id FROM tombstones) ORDER BY id'))
        if len(rows) > 128:
            raise ValueError('Pilot media library exceeds 128 attachments.')
        ranked = []
        for key, raw in rows:
            item = self.item(key)
            values = list(struct.unpack('<' + 'f' * DIMENSIONS, raw))
            vector(values)
            ranked.append(dict(item, similarity=sum(a * b for a, b in zip(query, values)), path=str(self.root / item['relative'])))
        ranked.sort(key=lambda item: (-item['similarity'], item['id']))
        result = ranked[:top]
        for item in result:
            self.item(item['id'])
        return result

    def publish_segments(self, key, rows, space):
        if not isinstance(space, dict) or type(space.get('dimensions')) is not int or space != {'model': MODEL, 'revision': REVISION, 'dimensions': DIMENSIONS}:
            raise ValueError('Media embeddings belong to a different model space.')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 32:
            raise ValueError('Supply at most 32 timestamped media embeddings.')
        item = self.item(key)
        decoded = inspect(self.root / item['relative'])
        if decoded['sha256'] != item['sha256'] or decoded['kind'] not in ('audio', 'video'):
            raise ValueError('Segment source differs from the approved recording or clip.')
        expected = {(row['start'], row['end']) for row in decoded['segments']}
        values = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'start', 'end', 'sha256', 'vector'} or any(type(row[field]) not in (int, float) or not math.isfinite(row[field]) for field in ('start', 'end')):
                raise ValueError('Malformed media segment.')
            span = (row['start'], row['end'])
            if row['sha256'] != item['sha256'] or span not in expected or span in seen:
                raise ValueError('Media segment differs from decoded source timestamps.')
            values.append((key, *span, vector(row['vector'])))
            seen.add(span)
        if seen != expected:
            raise ValueError('Publish all decoded segments together.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.item(key)
            db.execute('DELETE FROM segments WHERE id=?', (key,))
            db.executemany('INSERT INTO segments VALUES (?,?,?,?)', values)

    def search_segments(self, query, space, top=5):
        if not isinstance(space, dict) or type(space.get('dimensions')) is not int or space != {'model': MODEL, 'revision': REVISION, 'dimensions': DIMENSIONS}:
            raise ValueError('Query belongs to a different embedding space.')
        if type(top) is not int or not 1 <= top <= 10:
            raise ValueError('Media search top must be from one to ten.')
        query = struct.unpack('<' + 'f' * DIMENSIONS, vector(query))
        with self.connect() as db:
            rows = list(db.execute('SELECT segments.id,start,end,segments.vector FROM segments JOIN items USING(id) WHERE id NOT IN (SELECT id FROM tombstones) ORDER BY id,start,end LIMIT 4097'))
        if len(rows) > 4096:
            raise ValueError('Pilot media library exceeds 4096 segments.')
        ranked = []
        for key, start, end, raw in rows:
            if not all(type(value) in (int, float) and math.isfinite(value) for value in (start, end)) or not 0 <= start < end <= 60:
                raise ValueError('Stored segment timestamp is invalid.')
            values = list(struct.unpack('<' + 'f' * DIMENSIONS, raw))
            vector(values)
            ranked.append(dict(id=key, start=start, end=end, similarity=sum(a * b for a, b in zip(query, values))))
        ranked.sort(key=lambda row: (-row['similarity'], row['id'], row['start']))
        result = []
        decoded = {}
        for row in ranked[:top]:
            item = self.item(row['id'])
            if row['id'] not in decoded:
                decoded[row['id']] = inspect(self.root / item['relative'])
            source = decoded[row['id']]
            if source['sha256'] != item['sha256'] or dict(start=row['start'], end=row['end']) not in source['segments']:
                raise ValueError('Stored segment differs from decoded source timestamps.')
            result.append(dict(item, **row, path=str(self.root / item['relative'])))
        for item in result:
            self.item(item['id'])
        return result

    def forget(self, key):
        with self.connect() as db:
            present = db.execute('SELECT 1 FROM items WHERE id=?', (key,)).fetchone()
            pending = db.execute('SELECT 1 FROM tombstones WHERE id=?', (key,)).fetchone()
        if not present:
            if pending:
                return {'id': key, 'forgotten': True}
            raise ValueError('Attachment is absent or forgotten.')
        item = self.record(key)
        if not pending:
            self.item(key)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO tombstones VALUES (?,?)', (key, time.time()))
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            target = self.root / item['relative']
            if target.exists() or target.is_symlink():
                raw = read(target)
                if hashlib.sha256(raw).hexdigest() != item['sha256'] or format(raw)[0] != item['kind']:
                    raise ValueError('Attachment snapshot changed; preserve it for review.')
                target.unlink()
            db.execute('DELETE FROM items WHERE id=?', (key,))
            db.execute('DELETE FROM segments WHERE id=?', (key,))
        return {'id': key, 'forgotten': True}
