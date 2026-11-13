
import sys
import time
import gc
import torch

from paddleocr import PaddleOCR
from transformers import MarianMTModel, MarianTokenizer

torch.set_num_threads(2)

OCR_SETTINGS = {
    "device": "cpu",
    "text_detection_model_name": "PP-OCRv5_mobile_det",
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
}

TRANSLATION_MODELS = {
    "korean": "Helsinki-NLP/opus-mt-ko-en",
    "spanish": "Helsinki-NLP/opus-mt-es-en",
}

RECOGNITION_MODELS = {
    "korean": "korean_PP-OCRv5_mobile_rec",
    "spanish": "latin_PP-OCRv5_mobile_rec",
}


def create_ocr(language):
    return PaddleOCR(
        **OCR_SETTINGS,
        text_recognition_model_name=RECOGNITION_MODELS[language]
    )


def detect_language(texts):
    combined = "".join(texts)

    hangul = sum(
        1 for c in combined
        if "\uac00" <= c <= "\ud7a3"
        or "\u1100" <= c <= "\u11ff"
    )

    latin = sum(
        1 for c in combined
        if c.isascii() and c.isalpha()
    )

    return "korean" if hangul > latin else "spanish"


def translate(text, language):
    model_name = TRANSLATION_MODELS[language]

    print("\nLoading translation model...")
    start = time.time()

    tokenizer = MarianTokenizer.from_pretrained(model_name)
    model = MarianMTModel.from_pretrained(model_name)
    model.eval()

    print(f"Translation model loaded in {time.time() - start:.2f}s")

    print("\nTranslating...")
    start = time.time()

    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=512
    )

    with torch.inference_mode():
        output = model.generate(
            **inputs,
            max_new_tokens=256,
            num_beams=2
        )

    result = tokenizer.decode(
        output[0],
        skip_special_tokens=True
    )

    print(f"Translation took {time.time() - start:.2f}s")

    del model, tokenizer, inputs, output
    gc.collect()

    return result


def main(image_path):
    total_start = time.time()

    print("\n1. Running initial Korean recognition...")

    ocr = create_ocr("korean")
    result = ocr.predict(input=image_path)[0]
    first_text = result["rec_texts"]

    language = detect_language(first_text)

    print(f"\nDetected language: {language.upper()}")

    if language == "spanish":
        print("\n2. Switching to Latin recognition...")

        del ocr, result
        gc.collect()

        ocr = create_ocr("spanish")
        result = ocr.predict(input=image_path)[0]
        final_text = result["rec_texts"]
    else:
        final_text = first_text

    print("\nRecognised original text:")

    for line in final_text:
        print(line)

    # Release OCR memory before translation.
    del ocr, result
    gc.collect()

    original_text = "\n".join(final_text)

    if not original_text.strip():
        print("No text was detected.")
        return

    print("\n3. Translating into English...")

    english = translate(original_text, language)

    print("\n" + "=" * 45)
    print("FINAL ENGLISH TRANSLATION")
    print("=" * 45)
    print(english)
    print("=" * 45)

    print(f"\nTotal processing time: {time.time() - total_start:.2f}s")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python translator.py image.png")
        sys.exit(1)

    main(sys.argv[1])
