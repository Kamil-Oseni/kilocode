"""Finite CPU media inference for an externally admitted, supervised process.

No server, scanner or device capture. The caller owns request admission, memory
reserve, cancellation, queueing and actual process retirement.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import time
import wave
from library import MODEL, REVISION, DIMENSIONS, inspect, ordinary, read, vector


class Encoder:
    def __init__(self, manifest):
        ordinary(manifest)
        cfg = json.loads(read(manifest))
        if cfg.get('source') != MODEL or cfg.get('revision') != REVISION or cfg.get('status') != 'downloaded_verified':
            raise ValueError('Expected the approved pinned Gemma checkpoint.')
        root = Path(cfg['path'])
        ordinary(root, directory=True)
        for row in cfg['files']:
            path = root / row['name']
            if path.resolve().is_relative_to(root.resolve()) is False:
                raise ValueError('Checkpoint file leaves the approved model root.')
            if ordinary(path).st_size != row['bytes']:
                raise ValueError('Checkpoint file size differs.')
            with path.open('rb') as file:
                if hashlib.file_digest(file, 'sha256').hexdigest() != row['sha256']:
                    raise ValueError('Checkpoint file hash differs.')
        os.environ.update(CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
        import torch
        from sentence_transformers import SentenceTransformer
        torch.set_num_threads(6)
        self.model = SentenceTransformer(str(root), device='cpu', local_files_only=True, trust_remote_code=False,
                                         model_kwargs={'dtype': torch.float32})
        self.model.max_seq_length = 1024
        self.space = dict(model=MODEL, revision=REVISION, dimensions=DIMENSIONS)

    def encode(self, data, kwargs=None):
        values = self.model.encode(data, normalize_embeddings=True, show_progress_bar=False, **(kwargs or {})).tolist()
        vector(values)
        return values

    def index(self, library, key):
        item = library.item(key)
        path = library.root / item['relative']
        decoded = inspect(path)
        raw = read(path)
        if decoded['sha256'] != item['sha256'] or hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Media revision changed before inference.')
        if item['kind'] == 'image':
            from PIL import Image
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                values = self.encode({'text': '<|image|>', 'image': image.convert('RGB')})
            library.publish([dict(id=key, sha256=item['sha256'], vector=values)], self.space)
            return dict(id=key, indexed=True, segments=0)
        rows = []
        if item['kind'] == 'audio':
            import numpy as np
            with wave.open(io.BytesIO(raw), 'rb') as audio:
                samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
            for span in decoded['segments']:
                part = samples[round(span['start'] * 16000):round(span['end'] * 16000)]
                values = self.encode({'text': '<|audio|>', 'audio': part},
                                     {'processing_kwargs': {'audio': {'sampling_rate': 16000}}})
                rows.append(dict(span, sha256=item['sha256'], vector=values))
        if item['kind'] == 'video':
            import av
            import numpy as np
            stamp = time.monotonic()
            with av.open(io.BytesIO(raw)) as container:
                for count, frame in enumerate(container.decode(video=0)):
                    if count >= 1800 or time.monotonic() - stamp > 120:
                        raise ValueError('Video indexing exceeded its supervised pilot bound.')
                    point = float(frame.pts * frame.time_base)
                    if len(rows) >= len(decoded['segments']) or point != decoded['segments'][len(rows)]['start']:
                        continue
                    values = self.encode({'text': '<|video|>', 'video': np.expand_dims(frame.to_ndarray(format='rgb24'), 0)},
                                         {'processing_kwargs': {'video': {'do_sample_frames': False, 'add_timestamps': False}}})
                    rows.append(dict(decoded['segments'][len(rows)], sha256=item['sha256'], vector=values))
        library.publish_segments(key, rows, self.space)
        return dict(id=key, indexed=True, segments=len(rows))

    def search(self, library, query, segments=False, top=5):
        if not isinstance(query, str) or not query.strip() or len(query.encode('utf-8')) > 2048 or type(segments) is not bool:
            raise ValueError('Supply a bounded nonempty media query and explicit segment selection.')
        values = self.encode(query, {'prompt_name': 'SearchQuery', 'processing_kwargs': {'text': {'max_length': 512, 'truncation': True}}})
        return library.search_segments(values, self.space, top) if segments else library.search(values, self.space, top)
