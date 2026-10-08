import io
import sys
import wave
from fractions import Fraction

import av
import numpy as np

sys.path.insert(0, sys.argv[1])
from evaluator import Evaluator

output = io.BytesIO()
with av.open(output, 'w', format='avi') as container:
    video = container.add_stream('ffv1', rate=24)
    video.width = 32
    video.height = 32
    video.pix_fmt = 'bgr0'
    audio = container.add_stream('pcm_s16le', rate=44100)
    audio.layout = 'mono'
    for index in range(24):
        frame = av.VideoFrame.from_ndarray(np.zeros((32, 32, 3), dtype=np.uint8), format='rgb24')
        frame.pts = index
        frame.time_base = Fraction(1, 24)
        for packet in video.encode(frame):
            container.mux(packet)
    for packet in video.encode():
        container.mux(packet)
    frame = av.AudioFrame.from_ndarray(np.full((1, 44100), 1000, dtype=np.int16), format='s16', layout='mono')
    frame.sample_rate = 44100
    frame.pts = 0
    frame.time_base = Fraction(1, 44100)
    for packet in audio.encode(frame):
        container.mux(packet)
    for packet in audio.encode():
        container.mux(packet)

def transcribe(request, clip):
    with wave.open(io.BytesIO(clip), 'rb') as audio:
        samples = audio.getnframes()
        expected = round(request['end'] * 16000) - round(request['start'] * 16000)
        assert samples == expected, 'The selected final audio span was truncated.'
        assert audio.getframerate() == 16000
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
    return 'Complete selected span.'

evaluator = Evaluator('decoder-only-probe', lambda payload: None, transcribe)
for start, end in ((0, 1), (0.5, 1), (0.99, 1), (0.25, 0.5)):
    evaluator.transcript(dict(kind='video', start=start, end=end), output.getvalue())
print('Four exact video audio spans preserved.', flush=True)
