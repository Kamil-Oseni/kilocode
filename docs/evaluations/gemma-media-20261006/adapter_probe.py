"""Actual finite production encoder/catalog workflow on generated fixtures."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import wave
import av
from PIL import Image

folder = Path(__file__).parent
source = folder.parents[2]/'packages/kilo-vscode/script/memory/media'
sys.path.insert(0,str(source))
from library import Library
from encoder import Encoder
stamp = time.perf_counter()
encoder = Encoder('D:/Raya/Models/Catalog/google--embeddinggemma-2.json')
report = dict(load_seconds=time.perf_counter()-stamp, source_sha256=hashlib.sha256((source/'encoder.py').read_bytes()).hexdigest(), cases=[], scope='Finite generated-fixture production adapter workflow, not installed capture or general semantic quality.')
with tempfile.TemporaryDirectory(prefix='raya-media-adapter-') as temp:
    root = Path(temp)
    library = Library(root)
    ids = {}
    for color in ('red','blue'):
        path = root/(color+'.png')
        Image.new('RGB',(224,224),color).save(path)
        item = library.add(path,color)
        ids[color] = item['id']
        report['cases'].append(encoder.index(library,item['id']))
    path = root/'audio.wav'
    with wave.open(str(path),'wb') as file:
        file.setparams((1,2,16000,0,'NONE','not compressed'))
        file.writeframes(b'\x00\x00'*16000)
    item = library.add(path,'Synthetic silence')
    report['cases'].append(encoder.index(library,item['id']))
    path = root/'video.mp4'
    with av.open(str(path),mode='w') as file:
        stream = file.add_stream('mpeg4',rate=2)
        stream.width = stream.height = 224
        stream.pix_fmt = 'yuv420p'
        for index in range(4):
            for packet in stream.encode(av.VideoFrame.from_image(Image.new('RGB',(224,224),'red'))):
                file.mux(packet)
        for packet in stream.encode():
            file.mux(packet)
    item = library.add(path,'Red video')
    report['cases'].append(encoder.index(library,item['id']))
    for color in ('red','blue'):
        rows = encoder.search(library,'A solid '+color+' image')
        assert rows[0]['id'] == ids[color]
    rows = encoder.search(library,'A red image',segments=True,top=3)
    assert len(rows) == 3 and all(0<=row['start']<row['end']<=2 for row in rows)
    report.update(image_recall=2, segment_matches=len(rows), seconds=time.perf_counter()-stamp)
(folder/'adapter-smoke-results.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
