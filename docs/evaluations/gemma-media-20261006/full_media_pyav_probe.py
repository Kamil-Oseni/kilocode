"""Silent synthetic modality smoke test; no personal capture or quality score."""
import json
import os
from pathlib import Path
import time
import wave

os.environ.update(CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
import av
import numpy as np
import psutil
from PIL import Image
import torch
from sentence_transformers import SentenceTransformer

folder = Path(__file__).parent / 'media-fixtures'
folder.mkdir(exist_ok=True)
image = folder / 'red.png'
Image.new('RGB', (224, 224), (220, 15, 15)).save(image)
audio = folder / 'tone.wav'
with wave.open(str(audio), 'wb') as file:
    file.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
    tone = (np.sin(np.arange(16000) * 2 * np.pi * 440 / 16000) * 4000).astype('<i2')
    file.writeframes(tone.tobytes())
video = folder / 'red.mp4'
with av.open(str(video), mode='w') as file:
    stream = file.add_stream('mpeg4', rate=2)
    stream.width = stream.height = 224
    stream.pix_fmt = 'yuv420p'
    for index in range(4):
        frame = av.VideoFrame.from_image(Image.open(image))
        for packet in stream.encode(frame):
            file.mux(packet)
    for packet in stream.encode():
        file.mux(packet)

torch.set_num_threads(6)
manifest = json.loads(Path('D:/Raya/Models/Catalog/google--embeddinggemma-2.json').read_text())
stamp = time.perf_counter()
model = SentenceTransformer(manifest['path'], device='cpu', local_files_only=True, model_kwargs={'dtype': torch.float32})
report = dict(revision=manifest['revision'], parameters=sum(p.numel() for p in model.parameters()), load_seconds=time.perf_counter()-stamp, modalities={}, scope='Synthetic valid input/output smoke test, not semantic accuracy or installed service acceptance.')
for kind, source in [('image', image), ('audio', audio), ('video', video)]:
    stamp = time.perf_counter()
    data = {'text': '<|' + kind + '|>', kind: str(source)}
    kwargs = {}
    if kind == 'video':
        with av.open(str(source)) as file:
            frames = [frame.to_ndarray(format='rgb24') for frame in file.decode(video=0)]
        data[kind] = np.stack([frames[0], frames[2]])
        kwargs['processing_kwargs'] = {'video': {'do_sample_frames': False, 'video_metadata': [dict(total_num_frames=4, fps=2, duration=2, frames_indices=[0, 2], width=224, height=224)]}}
    values = model.encode(data, normalize_embeddings=True, show_progress_bar=False, **kwargs)
    assert values.shape == (768,) and np.isfinite(values).all()
    assert abs(float(np.linalg.norm(values)) - 1) < 0.001
    report['modalities'][kind] = dict(seconds=time.perf_counter()-stamp, dimensions=768, finite=True, normalized=True)
    print(json.dumps(dict(stage=kind, **report['modalities'][kind])), flush=True)
report['rss'] = psutil.Process().memory_info().rss
(folder.parent / 'media-smoke-results.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report), flush=True)
