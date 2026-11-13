import gc
import time
from pathlib import Path

import torch
from safetensors.torch import load_file
from transformers import AutoTokenizer, AutoModelForSeq2SeqLM


MODEL = "facebook/nllb-200-distilled-600M"

LANGUAGES = {
    "korean": "kor_Hang",
    "ko": "kor_Hang",
    "kor": "kor_Hang",
    "spanish": "spa_Latn",
    "es": "spa_Latn",
    "spa": "spa_Latn",
}

TARGET_LANGUAGE = "eng_Latn"


class TranslationEngine:

    def __init__(self):
        torch.set_num_threads(2)

        print("Loading NLLB translation engine...")
        start = time.time()

        cache_root = (
            Path.home()
            / ".cache/huggingface/hub/"
            / "models--facebook--nllb-200-distilled-600M"
        )

        safetensors_files = list(
            cache_root.glob("snapshots/*/model.safetensors")
        )

        if not safetensors_files:
            raise FileNotFoundError(
                "Cached NLLB safetensors model not found."
            )

        weights_path = safetensors_files[0].resolve()

        if not weights_path.exists():
            raise FileNotFoundError(
                f"NLLB weights missing: {weights_path}"
            )

        print("Loading tokenizer...")

        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL,
            src_lang="kor_Hang",
            local_files_only=True
        )

        print("Loading model architecture...")

        self.model = AutoModelForSeq2SeqLM.from_pretrained(
            MODEL,
            use_safetensors=True,
            low_cpu_mem_usage=True,
            local_files_only=True
        )

        print("Repairing shared embeddings...")

        weights = load_file(
            str(weights_path),
            device="cpu"
        )

        if "lm_head.weight" not in weights:
            raise RuntimeError(
                "Expected shared embedding tensor not found."
            )

        self.model.model.shared.weight = torch.nn.Parameter(
            weights["lm_head.weight"],
            requires_grad=False
        )

        self.model.tie_weights()

        del weights
        gc.collect()

        self.model.eval()

        meta_parameters = [
            name
            for name, param in self.model.named_parameters()
            if param.is_meta
        ]

        if meta_parameters:
            raise RuntimeError(
                f"Model has unloaded parameters: {meta_parameters}"
            )

        self.english_token_id = (
            self.tokenizer.convert_tokens_to_ids(TARGET_LANGUAGE)
        )

        if self.english_token_id is None:
            raise RuntimeError("English language token not found.")

        print(
            f"NLLB ready in {time.time() - start:.2f} seconds."
        )

    def translate_many(self, texts, source_language, batch_size=4):

        if source_language.lower() not in LANGUAGES:
            raise ValueError(
                "Supported languages: Korean and Spanish."
            )

        source_code = LANGUAGES[source_language.lower()]

        results = []

        texts = [
            str(text).strip()
            for text in texts
        ]

        for start in range(0, len(texts), batch_size):

            batch = texts[start:start + batch_size]

            if not batch:
                continue

            self.tokenizer.src_lang = source_code

            inputs = self.tokenizer(
                batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512
            )

            with torch.inference_mode():

                outputs = self.model.generate(
                    **inputs,
                    forced_bos_token_id=self.english_token_id,
                    max_new_tokens=128,
                    num_beams=2
                )

            translations = self.tokenizer.batch_decode(
                outputs,
                skip_special_tokens=True
            )

            results.extend(
                translation.strip()
                for translation in translations
            )

        return results

    def translate(self, text, source_language):

        return self.translate_many(
            [text],
            source_language
        )[0]


if __name__ == "__main__":

    engine = TranslationEngine()

    print("\nKorean test:")
    korean = engine.translate(
        "이까짓 일로 왜 널 좋아해서 했던 내 행동을 기만으로 만들어.",
        "korean"
    )
    print(korean)

    print("\nSpanish test:")
    spanish = engine.translate(
        "Quiero preguntarte algo, por casualidad.",
        "spanish"
    )
    print(spanish)

    print("\nBatch test:")
    batch = engine.translate_many(
        [
            "안녕하세요.",
            "오늘은 날씨가 좋네요."
        ],
        "korean"
    )

    for translation in batch:
        print("-", translation)

    print("\nAll translation tests completed.")
