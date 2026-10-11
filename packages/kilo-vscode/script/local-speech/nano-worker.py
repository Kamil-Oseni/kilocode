"""Reusable CPU speech worker. Each request owns a validated service temp folder."""
import json
import os
from pathlib import Path
import sys

os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['HF_HUB_OFFLINE'] = '1'
parent = (Path(os.environ.get('RAYA_SPEECH_ROOT', str(Path(__file__).parent))) / 'temp').resolve()
catalog = Path(os.environ.get('RAYA_SPEECH_CATALOG', r'D:\Raya\Models\Catalog'))
model = None

def record(root, name, data):
    file = root / (name + '.tmp')
    file.write_text(json.dumps(data), encoding='utf-8')
    file.replace(root / (name + '.json'))

for line in sys.stdin:
    request = json.loads(line)
    root = Path(request['path']).resolve()
    if root.parent != parent or not root.is_dir() or root.is_symlink() or root.is_junction():
        raise RuntimeError('Worker output must remain in an allocated service temp folder.')
    try:
        import numpy as np
        import soundfile as sf
        import torch
        if model is None:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            torch.set_num_threads(6)
            manifest = json.loads((catalog / 'ResembleAI--chatterbox-nano.json').read_text(encoding='utf-8-sig'))
            prefs = json.loads((catalog / 'speech-preferences.json').read_text(encoding='utf-8-sig'))
            model = ChatterboxTurboTTS.from_local(manifest['path'], device='cpu', nano=True)
            model.prepare_conditionals(prefs['reference_audio'])
        for index, text in enumerate(request['chunks']):
            with torch.inference_mode():
                wav = model.generate(text)
            samples = wav.squeeze().numpy()
            if not samples.size or not np.isfinite(samples).all():
                raise RuntimeError('Synthesis produced invalid audio.')
            sf.write(root / f'{index}.wav', samples, model.sr, format='WAV', subtype='PCM_16')
            record(root, str(index), {'seconds': round(len(samples) / model.sr, 3)})
        record(root, 'done', {'chunks': len(request['chunks'])})
    except Exception as err:
        record(root, 'error', {'message': str(err), 'type': type(err).__name__})
        raise
