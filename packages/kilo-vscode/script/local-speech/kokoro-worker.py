"""Isolated CPU fallback worker; its filename must not shadow the kokoro package."""
import json
import os
import sys
from pathlib import Path

os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HOME'] = r'D:\Raya\Models\Cache\speech'
root = Path(sys.argv[1]).resolve()
parent = (Path(os.environ.get('RAYA_SPEECH_ROOT', str(Path(__file__).parent))) / 'temp').resolve()
if root.parent != parent:
    raise RuntimeError('Worker output must remain in its allocated service temp directory.')


def record(name, data):
    file = root / (name + '.tmp')
    file.write_text(json.dumps(data), encoding='utf-8')
    file.replace(root / (name + '.json'))


try:
    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KModel, KPipeline
    torch.set_num_threads(6)
    manifest = json.loads(Path(r'D:\Raya\Models\Catalog\hexgrad--Kokoro-82M.json').read_text(encoding='utf-8-sig'))
    folder = Path(manifest['path'])
    model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(folder / 'config.json'), model=str(folder / 'kokoro-v1_0.pth')).to('cpu').eval()
    pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=model, device='cpu')
    voice = torch.load(folder / 'voices' / 'am_onyx.pt', map_location='cpu', weights_only=True)
    request = json.load(sys.stdin)
    for index, text in enumerate(request['chunks']):
        with torch.inference_mode():
            parts = [result.audio.numpy() for result in pipeline(text, voice=voice, speed=1.0)]
        audio = np.concatenate(parts)
        if not audio.size or not np.isfinite(audio).all():
            raise RuntimeError('Kokoro produced invalid audio.')
        sf.write(root / f'{index}.wav', audio, 24000, subtype='PCM_16')
        record(str(index), {'seconds': round(len(audio) / 24000, 3)})
except Exception as err:
    record('error', {'message': str(err), 'type': type(err).__name__})
    raise
