import sys
import time
import gc

from paddleocr import PaddleOCR
from translation_engine import TranslationEngine


COMMON = {
    "device": "cpu",
    "text_detection_model_name": "PP-OCRv5_mobile_det",
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
}


def create_ocr(model):
    return PaddleOCR(
        **COMMON,
        text_recognition_model_name=model
    )


def extract_text(result):
    return result.get("rec_texts", [])


def detect_language(texts):
    combined = "".join(texts)

    hangul = sum(
        1 for char in combined
        if "\uac00" <= char <= "\ud7a3"
        or "\u1100" <= char <= "\u11ff"
    )

    latin = sum(
        1 for char in combined
        if (
            "a" <= char.lower() <= "z"
            or "\u00c0" <= char <= "\u024f"
        ) and char.isalpha()
    )

    if hangul > latin:
        return "korean"

    return "spanish"


def main():

    if len(sys.argv) < 2:
        print("Usage: python auto_translate.py image.png")
        sys.exit(1)

    image_path = sys.argv[1]
    total_start = time.time()

    # -----------------------------
    # STEP 1: INITIAL KOREAN OCR
    # -----------------------------

    print("\n[1/3] Loading Korean OCR...")
    start = time.time()

    korean_ocr = create_ocr(
        "korean_PP-OCRv5_mobile_rec"
    )

    print(f"Korean OCR loaded in {time.time() - start:.2f}s")

    print("Recognising text...")
    start = time.time()

    first_result = korean_ocr.predict(
        input=image_path
    )[0]

    first_text = extract_text(first_result)

    language = detect_language(first_text)

    print(f"Detected language: {language}")

    # Release Korean OCR before loading another recogniser.
    del first_result
    del korean_ocr
    gc.collect()

    # -----------------------------
    # STEP 2: FINAL OCR
    # -----------------------------

    if language == "spanish":

        print("\nLoading Spanish OCR...")

        latin_ocr = create_ocr(
            "latin_PP-OCRv5_mobile_rec"
        )

        final_result = latin_ocr.predict(
            input=image_path
        )[0]

        final_text = extract_text(final_result)

        del final_result
        del latin_ocr
        gc.collect()

    else:
        final_text = first_text

    final_text = [
        str(line).strip()
        for line in final_text
        if str(line).strip()
    ]

    if not final_text:
        print("No text was detected in the image.")
        sys.exit(1)

    print("\nRecognised original text:")

    for line in final_text:
        print("-", line)

    # -----------------------------
    # STEP 3: TRANSLATION
    # -----------------------------

    print("\n[2/3] Loading translation engine...")

    engine = TranslationEngine()

    print("\n[3/3] Translating into English...")

    start = time.time()

    translations = engine.translate_many(
        final_text,
        language
    )

    print(f"Translation took {time.time() - start:.2f}s")

    # -----------------------------
    # RESULTS
    # -----------------------------

    print("\n" + "=" * 45)
    print("FINAL ENGLISH TRANSLATION")
    print("=" * 45)

    for index, (original, translated) in enumerate(
        zip(final_text, translations), start=1
    ):
        print(f"\n{index}. ORIGINAL: {original}")
        print(f"   ENGLISH:  {translated}")

    print("\n" + "=" * 45)
    print(f"Total processing time: {time.time() - total_start:.2f}s")
    print("=" * 45)


if __name__ == "__main__":
    main()
