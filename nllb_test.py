import torch
import time

from transformers import AutoTokenizer, AutoModelForSeq2SeqLM

torch.set_num_threads(2)

MODEL = "facebook/nllb-200-distilled-600M"


def main():
    print("Loading NLLB model...")
    start = time.time()

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL,
        src_lang="kor_Hang"
    )

    model = AutoModelForSeq2SeqLM.from_pretrained(
        MODEL,
        use_safetensors=True,
        low_cpu_mem_usage=False
    )

    model.eval()
    model.to("cpu")

    print(f"Model loaded in {time.time() - start:.2f}s")

    # Check that all model weights are actually loaded
    meta_parameters = [
        name for name, param in model.named_parameters()
        if param.is_meta
    ]

    if meta_parameters:
        print("ERROR: Some model weights are still missing:")
        print(meta_parameters[:10])
        return

    sentences = [
        "이까짓 일로 왜 널 좋아해서 했던 내 행동을 기만으로 만들어.",
        "왜 널 좋아해서 했던 내 행동을 기만으로 만들어."
    ]

    for sentence in sentences:
        inputs = tokenizer(
            sentence,
            return_tensors="pt",
            truncation=True
        )

        start = time.time()

        with torch.inference_mode():
            output = model.generate(
                **inputs,
                forced_bos_token_id=tokenizer.convert_tokens_to_ids("eng_Latn"),
                max_new_tokens=128,
                num_beams=2
            )

        translation = tokenizer.decode(
            output[0],
            skip_special_tokens=True
        )

        print("\nKOREAN:", sentence)
        print("ENGLISH:", translation)
        print(f"Translation time: {time.time() - start:.2f}s")

    print("\nTest complete.")


if __name__ == "__main__":
    main()
