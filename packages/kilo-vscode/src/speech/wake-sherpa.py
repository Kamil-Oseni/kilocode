"""Prospective local-only sherpa PCM worker. Not integrated, installed, or executed.

stdin: one ASCII kind plus uint32-le byte length, then payload.
P: signed int16-le mono 16kHz PCM, 1..1600 samples; R: reset;
E/D: enable/disable; B/F: playback begin/finish; Q: ordinary stop.
Control payloads are empty. EOF between frames is also ordinary stop.
The reviewed, tokenized keyword file must contain one keyword with @HEY_RAYA.
Start disabled; wake disarms until explicit E. Playback finish does not rearm.
stdout contains finite ready/wake/closed metadata, never PCM or transcription.
"""
import argparse
import gc
import hashlib
import json
import os
import pathlib
import stat
import struct
import sys


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read(stream, count, boundary=False):
    data = bytearray()
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            if boundary and not data:
                return None
            raise ValueError("Truncated local wake frame")
        data.extend(chunk)
    return data


def pin(path, sha):
    path = pathlib.Path(path)
    assert path.is_absolute() and path.resolve(strict=True) == path
    for parent in (path, *path.parents):
        row = parent.lstat()
        assert not stat.S_ISLNK(row.st_mode) and not getattr(row, "st_file_attributes", 0) & 1024
    with path.open("rb") as stream:
        row = os.fstat(stream.fileno())
        assert stat.S_ISREG(row.st_mode) and row.st_nlink == 1
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
        after = os.fstat(stream.fileno())
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    assert digest == sha and all(getattr(row, key) == getattr(after, key) == getattr(path.stat(), key) for key in fields)
    return str(path)


def serve(kws, source):
    stream = kws.create_stream()
    enabled = False
    playing = False
    errors = []
    try:
        emit({"status": "ready", "protocol": 1, "sampleRate": 16000, "enabled": False})
        while True:
            header = read(source, 5, boundary=True)
            if header is None:
                break
            kind = chr(header[0])
            size = struct.unpack_from("<I", header, 1)[0]
            assert kind in "PERDBFQ" and ((kind == "P" and 0 < size <= 3200 and size % 2 == 0) or (kind != "P" and size == 0))
            pcm = read(source, size)
            samples = []
            try:
                if kind == "Q":
                    break
                if kind == "P":
                    if not enabled or playing:
                        continue
                    samples = [value[0] / 32768.0 for value in struct.iter_unpack("<h", pcm)]
                    stream.accept_waveform(16000, samples)
                    while kws.is_ready(stream):
                        kws.decode_stream(stream)
                        result = kws.get_result(stream)
                        if result:
                            assert result == "HEY_RAYA", "Unexpected keyword refused"
                            enabled = False
                            kws.reset_stream(stream)
                            emit({"status": "wake", "keyword": "HEY RAYA"})
                            break
                    continue
                kws.reset_stream(stream)
                if kind == "E":
                    enabled = not playing
                if kind in "RDB":
                    enabled = False
                if kind == "B":
                    playing = True
                if kind == "F":
                    playing = False
            finally:
                pcm[:] = b"\0" * len(pcm)
                samples[:] = [0.0] * len(samples)
    except BaseException as err:
        errors.append(err)
    finally:
        enabled = False
        try:
            stream.input_finished()
        except BaseException as err:
            errors.append(err)
        try:
            kws.reset_stream(stream)
        except BaseException as err:
            errors.append(err)
        del stream
    if errors:
        raise BaseExceptionGroup("Local wake input/cleanup failed", errors)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, help="Reviewed extracted regular-file manifest, not the model archive")
    args = parser.parse_args()
    cfg = json.loads(pathlib.Path(args.assets).read_text(encoding="utf-8"))
    assert set(cfg) == {"encoder", "decoder", "joiner", "tokens", "keywords"}
    files = {key: pin(value["path"], value["sha256"]) for key, value in cfg.items()}
    keywords = pathlib.Path(files["keywords"]).read_text(encoding="utf-8")
    assert len(keywords) < 4096 and len(keywords.strip().splitlines()) == 1 and keywords.strip().endswith("@HEY_RAYA")
    # Only an explicitly invoked, admitted worker imports native code/loads models.
    import sherpa_onnx
    kws = sherpa_onnx.KeywordSpotter(
        encoder=files["encoder"], decoder=files["decoder"], joiner=files["joiner"],
        tokens=files["tokens"], keywords_file=files["keywords"],
        num_threads=1, sample_rate=16000, provider="cpu",
    )
    try:
        serve(kws, sys.stdin.buffer)
    finally:
        del kws
        gc.collect()
    emit({"status": "closed", "protocol": 1})


if __name__ == "__main__":
    main()
