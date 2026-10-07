"""Actual bounded PIL/WAV/PyAV decoding, without model loading or playback."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import wave
import av
from PIL import Image, UnidentifiedImageError

spec = importlib.util.spec_from_file_location('media_library', Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Decode(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-media-decode-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def audio(self, seconds=31, rate=16000):
        path = self.root/'audio.wav'
        with wave.open(str(path), 'wb') as file:
            file.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            file.writeframes(b'\x00\x00' * (rate * seconds))
        return path

    def test_decoded_image_has_content_identity(self):
        path = self.root/'image.png'
        Image.new('RGB', (128, 64), 'red').save(path)
        result = module.inspect(path)
        self.assertEqual((result['width'], result['height']), (128, 64))
        self.assertEqual(result['sha256'], module.hashlib.sha256(path.read_bytes()).hexdigest())

    def test_signature_without_valid_image_is_refused(self):
        path = self.root/'invalid.png'
        path.write_bytes(b'\x89PNG\r\n\x1a\ninvalid')
        with self.assertRaises(UnidentifiedImageError):
            module.inspect(path)

    def test_large_image_is_refused(self):
        path = self.root/'large.png'
        Image.new('RGB', (4097, 1)).save(path)
        with self.assertRaisesRegex(ValueError, 'megapixel'):
            module.inspect(path)

    def test_audio_chunks_have_exact_timestamps(self):
        result = module.inspect(self.audio())
        self.assertEqual(result['duration'], 31)
        self.assertEqual(result['segments'], [dict(start=0, end=30), dict(start=30, end=31)])

    def test_audio_bounds_and_truncation(self):
        with self.assertRaisesRegex(ValueError, '60-second'):
            module.inspect(self.audio(seconds=61))
        with self.assertRaisesRegex(ValueError, '16 kHz'):
            module.inspect(self.audio(rate=8000))
        path = self.audio()
        path.write_bytes(path.read_bytes()[:-2])
        with self.assertRaisesRegex(ValueError, 'frame count'):
            module.inspect(path)

    def test_video_is_decoded_with_timestamped_samples(self):
        path = self.root/'video.mp4'
        with av.open(str(path), mode='w') as file:
            stream = file.add_stream('mpeg4', rate=2)
            stream.width = stream.height = 64
            stream.pix_fmt = 'yuv420p'
            for index in range(4):
                frame = av.VideoFrame.from_image(Image.new('RGB', (64, 64), 'blue'))
                for packet in stream.encode(frame):
                    file.mux(packet)
            for packet in stream.encode():
                file.mux(packet)
        result = module.inspect(path)
        self.assertEqual(result['duration'], 2)
        self.assertEqual(result['segments'], [dict(start=0, end=1), dict(start=1, end=2)])
        self.assertEqual(result['audio_streams'], 0)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
