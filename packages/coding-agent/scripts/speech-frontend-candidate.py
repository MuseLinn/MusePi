import argparse
import contextlib
import json
import os
import re
import sys
import time


def rss_bytes():
    try:
        import psutil

        return psutil.Process(os.getpid()).memory_info().rss
    except ImportError:
        pass
    if os.name == "nt":
        import ctypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("page_fault_count", ctypes.c_ulong),
                ("peak_working_set_size", ctypes.c_size_t),
                ("working_set_size", ctypes.c_size_t),
                ("quota_peak_paged_pool_usage", ctypes.c_size_t),
                ("quota_paged_pool_usage", ctypes.c_size_t),
                ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
                ("quota_non_paged_pool_usage", ctypes.c_size_t),
                ("pagefile_usage", ctypes.c_size_t),
                ("peak_pagefile_usage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if ctypes.windll.psapi.GetProcessMemoryInfo(
            ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        ):
            return counters.working_set_size
        return 0
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_audio(path):
    import soundfile as sf

    samples, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    return samples[:, 0].copy(), sample_rate


def write_audio(path, samples, sample_rate):
    import soundfile as sf

    sf.write(path, samples, sample_rate, subtype="PCM_16")
    return os.path.abspath(path)


def output_path(implementation, item_id):
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", item_id)
    return os.path.join(os.getcwd(), f"{implementation}-{safe_id}.wav")


class PassthroughCandidate:
    def prepare(self):
        return None

    def extract(self, request):
        if request["id"] == "reject":
            return None, 16000
        return request["mixturePath"], 16000


class OpenSpeakerBeamCandidate:
    def __init__(self, root):
        self.root = root

    def prepare(self):
        import torch
        from resemblyzer import VoiceEncoder

        repo = os.path.join(self.root, "OpenSpeakerBeam-SS")
        sys.path.insert(0, repo)
        from model import SpeakerBeamSS

        self.torch = torch
        torch.set_num_threads(2)
        self.device = torch.device("cpu")
        self.model = SpeakerBeamSS().to(self.device)
        checkpoint = os.path.join(self.root, "best_model.pth")
        self.model.load_state_dict(torch.load(checkpoint, map_location=self.device, weights_only=True))
        self.model.eval()
        self.encoder = VoiceEncoder(device=self.device)

    def extract(self, request):
        import numpy as np
        import torch.nn.functional as F
        from tools import get_speaker_embeddings_batch

        torch = self.torch
        mixture, mixture_rate = read_audio(request["mixturePath"])
        if mixture_rate != 16000:
            raise ValueError("OpenSpeakerBeam input must be 16 kHz")
        mixture_tensor = torch.from_numpy(mixture).float().unsqueeze(0).unsqueeze(0).to(self.device)
        embeddings = []
        for enrollment_path in request["enrollmentPaths"]:
            enrollment, enrollment_rate = read_audio(enrollment_path)
            if enrollment_rate != 16000:
                raise ValueError("OpenSpeakerBeam enrollment must be 16 kHz")
                continue
            enrollment_tensor = torch.from_numpy(enrollment).float().unsqueeze(0).unsqueeze(0).to(self.device)
            embeddings.append(get_speaker_embeddings_batch(self.encoder, enrollment_tensor))
        if not embeddings:
            raise ValueError("OpenSpeakerBeam requires enrollment audio")
        enrollment_embedding = F.normalize(torch.mean(torch.stack(embeddings), dim=0), dim=1)
        with torch.no_grad():
            enhanced = self.model(mixture_tensor, enrollment_embedding)
        samples = enhanced.squeeze().cpu().numpy().astype(np.float32)
        return write_audio(output_path("openspeakerbeam", request["id"]), samples, 16000), 16000


class ClearVoiceSpeakerBeamCandidate:
    def __init__(self, root):
        self.root = root

    def prepare(self):
        import torch

        repo = os.path.join(self.root, "ClearerVoice-Studio", "train", "target_speaker_extraction")
        sys.path.insert(0, repo)
        from networks import network_wrapper

        self.torch = torch
        torch.set_num_threads(2)
        self.device = torch.device("cpu")
        audio = type("AudioConfig", (), {})()
        audio.backbone = "SpEx-plus"
        audio.L = 20
        audio.N = 256
        audio.X = 8
        audio.R = 4
        audio.B = 256
        audio.H = 512
        audio.P = 3
        audio.norm = "gLN"
        audio.non_linear = "relu"
        audio.speakers = 101
        args = type("Args", (), {})()
        args.network_audio = audio
        args.causal = 0
        args.device = self.device
        self.model = network_wrapper(args).to(self.device)
        checkpoint_path = os.path.join(self.root, "clearvoice-checkpoint.pt")
        checkpoint = torch.load(checkpoint_path, map_location=self.device, weights_only=True)
        pretrained = checkpoint["model"]
        state = self.model.state_dict()
        for key in state:
            if key in pretrained and state[key].shape == pretrained[key].shape:
                state[key] = pretrained[key]
            elif f"module.{key}" in pretrained and state[key].shape == pretrained[f"module.{key}"].shape:
                state[key] = pretrained[f"module.{key}"]
        self.model.load_state_dict(state)
        self.model.eval()

    def extract(self, request):
        import numpy as np
        from scipy.signal import resample_poly

        torch = self.torch
        mixture, mixture_rate = read_audio(request["mixturePath"])
        if mixture_rate != 16000:
            raise ValueError("ClearerVoice reference input must be 16 kHz")
        mixture_8k = resample_poly(mixture, 1, 2).astype(np.float32)
        enrollment_parts = []
        for enrollment_path in request["enrollmentPaths"]:
            enrollment, enrollment_rate = read_audio(enrollment_path)
            if enrollment_rate != 16000:
                raise ValueError("ClearerVoice enrollment must be 16 kHz")
            enrollment_parts.append(resample_poly(enrollment, 1, 2).astype(np.float32))
        if not enrollment_parts:
            raise ValueError("ClearerVoice requires enrollment audio")
        enrollment_8k = np.concatenate(enrollment_parts)
        mixture_tensor = torch.from_numpy(mixture_8k).float().unsqueeze(0).to(self.device)
        enrollment_tensor = torch.from_numpy(enrollment_8k).float().unsqueeze(0).to(self.device)
        enrollment_length = torch.tensor([len(enrollment_8k)], dtype=torch.long).to(self.device)
        speakers = torch.tensor([-1], dtype=torch.long).to(self.device)
        with torch.no_grad():
            estimated = self.model(mixture_tensor, (enrollment_tensor, enrollment_length, speakers))
        samples = estimated[0].squeeze().cpu().numpy().astype(np.float32)
        samples_16k = resample_poly(samples, 2, 1).astype(np.float32)
        return write_audio(output_path("clearvoice-speakerbeam", request["id"]), samples_16k, 16000), 16000


class DpdfnetCandidate:
    def __init__(self, root):
        self.root = root

    def prepare(self):
        import sherpa_onnx

        config = sherpa_onnx.OnlineSpeechDenoiserConfig(
            model=sherpa_onnx.OfflineSpeechDenoiserModelConfig(
                dpdfnet=sherpa_onnx.OfflineSpeechDenoiserDpdfNetModelConfig(
                    model=os.path.join(self.root, "dpdfnet2.onnx")
                ),
                num_threads=1,
                debug=False,
                provider="cpu",
            )
        )
        if not config.validate():
            raise ValueError(f"Invalid DPDFNet config: {config}")
        self.denoiser = sherpa_onnx.OnlineSpeechDenoiser(config)

    def extract(self, request):
        import numpy as np

        samples, sample_rate = read_audio(request["mixturePath"])
        output = []
        for start in range(0, len(samples), self.denoiser.frame_shift_in_samples):
            chunk = samples[start : start + self.denoiser.frame_shift_in_samples]
            denoised = self.denoiser.run(chunk, sample_rate)
            output.append(np.asarray(denoised.samples, dtype=np.float32))
        flush_started = time.perf_counter()
        output.append(np.asarray(self.denoiser.flush().samples, dtype=np.float32))
        self.endpoint_ms = (time.perf_counter() - flush_started) * 1000
        enhanced = np.concatenate(output) if output else np.asarray([], dtype=np.float32)
        return write_audio(output_path("dpdfnet", request["id"]), enhanced, self.denoiser.sample_rate), self.denoiser.sample_rate


def create_candidate(implementation, root):
    if implementation == "passthrough":
        return PassthroughCandidate()
    if implementation == "openspeakerbeam":
        return OpenSpeakerBeamCandidate(root)
    if implementation == "clearvoice-speakerbeam":
        return ClearVoiceSpeakerBeamCandidate(root)
    if implementation == "dpdfnet":
        return DpdfnetCandidate(root)
    raise ValueError(f"Unknown candidate implementation: {implementation}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation", required=True)
    args = parser.parse_args()
    candidate = create_candidate(args.implementation, os.getcwd())

    for line in sys.stdin:
        request = json.loads(line)
        if request["type"] == "close":
            return
        if request["type"] == "prepare":
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                candidate.prepare()
            emit({"type": "prepare", "loadMs": (time.perf_counter() - started) * 1000, "rssBytes": rss_bytes()})
            continue
        started = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            audio_path, sample_rate = candidate.extract(request)
        response = {
            "type": "result",
            "id": request["id"],
            "audioPath": audio_path,
            "sampleRate": sample_rate,
            "loadMs": 0,
            "inferenceMs": (time.perf_counter() - started) * 1000,
            "rssBytes": rss_bytes(),
        }
        endpoint_ms = getattr(candidate, "endpoint_ms", None)
        if endpoint_ms is not None:
            response["endpointMs"] = endpoint_ms
        emit(response)


if __name__ == "__main__":
    main()
