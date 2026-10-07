"""Pinned CPU retrieval models. No generation, user-note writes or automatic capture."""
import json
import os
import time
from pathlib import Path

os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
# HF_HOME is supplied and checked by the selected private bootstrap.
import torch
from transformers import AutoModel, AutoModelForCausalLM, AutoTokenizer
from transformers.utils import logging

logging.disable_progress_bar()

torch.set_num_threads(6)
CATALOG = Path(r'D:\Raya\Models\Catalog')
TASK = 'Given a question, retrieve relevant personal notes that directly answer the question.'


class Embeddings:
    def __init__(self):
        self.manifest = dict(MANIFESTS['qwen3-embedding-0.6b'])
        self.tokenizer = AutoTokenizer.from_pretrained(self.manifest['path'], local_files_only=True, padding_side='left')
        self.model = AutoModel.from_pretrained(self.manifest['path'], local_files_only=True, dtype=torch.float32).to('cpu').eval()

    def encode(self, texts, query=False):
        if not isinstance(texts, list) or not 1 <= len(texts) <= 32 or any(not isinstance(text, str) or not 0 < len(text.strip()) <= 8000 for text in texts):
            raise ValueError('Supply 1–32 nonempty strings of at most 8000 characters.')
        values = [f'Instruct: {TASK}\nQuery:{text}' for text in texts] if query else texts
        if any(len(tokens) > 512 for tokens in self.tokenizer(values, truncation=False)['input_ids']):
            raise ValueError('Text exceeds the 512-token service window; split documents into smaller chunks.')
        parts = []
        for index in range(0, len(values), 2):
            inputs = self.tokenizer(values[index:index + 2], padding=True, truncation=True, max_length=512, return_tensors='pt')
            with torch.inference_mode():
                output = self.model(**inputs, use_cache=False).last_hidden_state[:, -1]
                parts.append(torch.nn.functional.normalize(output, p=2, dim=1))
        result = torch.cat(parts)
        if not torch.isfinite(result).all():
            raise RuntimeError('Embedding output is not finite.')
        return result


class Gemma:
    """Text-only Gemma for a caller-admitted pinned manifest; no service selection."""
    def __init__(self, manifest):
        if not isinstance(manifest, dict) or manifest.get('source') != 'google/embeddinggemma-2' or manifest.get('revision') != '914f7f89142e33e77833254d9c9b90c3cef7303b' or manifest.get('status') != 'downloaded_verified':
            raise ValueError('Supply the admitted pinned Gemma checkpoint.')
        from sentence_transformers import SentenceTransformer
        self.manifest = dict(manifest)
        self.model = SentenceTransformer(self.manifest['path'], device='cpu', local_files_only=True,
                                         trust_remote_code=False, config_kwargs={'vision_config': None, 'audio_config': None},
                                         model_kwargs={'dtype': torch.float32})
        self.model.max_seq_length = 512
        self.tokenizer = self.model.tokenizer
        if not all(name in self.model.prompts for name in ('Document', 'SearchQuery')):
            raise ValueError('Expected the pinned Gemma retrieval prompts.')

    def encode(self, texts, query=False):
        if type(query) is not bool or not isinstance(texts, list) or not 1 <= len(texts) <= 32 or any(not isinstance(text, str) or not 0 < len(text.strip()) <= 8000 for text in texts):
            raise ValueError('Supply 1–32 nonempty strings and an explicit query selection.')
        name = 'SearchQuery' if query else 'Document'
        prompt = self.model.prompts[name]
        values = [prompt + text for text in texts]
        if any(len(tokens) > 512 for tokens in self.tokenizer(values, truncation=False)['input_ids']):
            raise ValueError('Text exceeds the 512-token service window; split documents into smaller chunks.')
        result = self.model.encode(texts, prompt_name=name, batch_size=2, normalize_embeddings=True,
                                   convert_to_tensor=True, show_progress_bar=False)
        if result.shape != (len(texts), 768) or not torch.isfinite(result).all() or not torch.allclose(torch.linalg.vector_norm(result, dim=1), torch.ones(len(texts)), atol=0.001):
            raise RuntimeError('Gemma returned incompatible or invalid embeddings.')
        return result


class Reranker:
    def __init__(self):
        self.manifest = dict(MANIFESTS['qwen3-reranker-0.6b'])
        self.tokenizer = AutoTokenizer.from_pretrained(self.manifest['path'], local_files_only=True, padding_side='left')
        self.model = AutoModelForCausalLM.from_pretrained(self.manifest['path'], local_files_only=True, dtype=torch.float32).to('cpu').eval()
        self.yes = self.tokenizer.convert_tokens_to_ids('yes')
        self.no = self.tokenizer.convert_tokens_to_ids('no')
        prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
        suffix = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
        self.prefix = self.tokenizer.encode(prefix, add_special_tokens=False)
        self.suffix = self.tokenizer.encode(suffix, add_special_tokens=False)

    def rank(self, query, documents):
        if not isinstance(query, str) or not 0 < len(query.strip()) <= 2000:
            raise ValueError('Query must contain 1–2000 characters.')
        if not isinstance(documents, list) or not 1 <= len(documents) <= 16 or any(not isinstance(text, str) or not 0 < len(text.strip()) <= 8000 for text in documents):
            raise ValueError('Supply 1–16 nonempty documents of at most 8000 characters.')
        scores = []
        for index in range(0, len(documents), 2):
            values = [f'<Instruct>: {TASK}\n<Query>: {query}\n<Document>: {text}' for text in documents[index:index + 2]]
            inputs = self.tokenizer(values, padding=False, truncation=False, add_special_tokens=False)
            if any(len(tokens) + len(self.prefix) + len(self.suffix) > 512 for tokens in inputs['input_ids']):
                raise ValueError('Query/document pair exceeds the 512-token service window; use smaller chunks.')
            inputs['input_ids'] = [self.prefix + tokens + self.suffix for tokens in inputs['input_ids']]
            # Rebuild attention masks after adding the protocol prefix/suffix.
            del inputs['attention_mask']
            batch = self.tokenizer.pad(inputs, padding=True, return_tensors='pt')
            with torch.inference_mode():
                logits = self.model(**batch, use_cache=False, logits_to_keep=1).logits[:, -1]
                pairs = torch.stack([logits[:, self.no], logits[:, self.yes]], dim=1)
                scores.extend(torch.softmax(pairs, dim=1)[:, 1].tolist())
        return [{'index': index, 'score': score} for index, score in sorted(enumerate(scores), key=lambda item: item[1], reverse=True)]
