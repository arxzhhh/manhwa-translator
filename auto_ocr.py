
import sys
import time
from paddleocr import PaddleOCR

if len(sys.argv) < 2:
    print("Usage: python auto_ocr.py image.png")
    sys.exit(1)

image_path = sys.argv[1]

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
    return result["rec_texts"]

def detect_language(texts):
    combined = "".join(texts)

    hangul = sum(
        1 for char in combined
        if "\uac00" <= char <= "\ud7a3"
        or "\u1100" <= char <= "\u11ff"
    )

    latin = sum(
        1 for char in combined
        if char.isascii() and char.isalpha()
    )

    if hangul > latin:
        return "korean"

    return "spanish"

print("Loading Korean OCR...")
start = time.time()

korean_ocr = create_ocr("korean_PP-OCRv5_mobile_rec")

print(f"Loaded in {time.time() - start:.2f}s")

print("Running initial recognition...")
start = time.time()

first_result = korean_ocr.predict(input=image_path)[0]
first_text = extract_text(first_result)

language = detect_language(first_text)

print(f"Detected language: {language}")

if language == "spanish":
    print("Running improved Latin recognition...")

    latin_ocr = create_ocr("latin_PP-OCRv5_mobile_rec")
    final_result = latin_ocr.predict(input=image_path)[0]
    final_text = extract_text(final_result)
else:
    final_text = first_text

print("\nRecognised text:")
for line in final_text:
    print(line)

print(f"\nProcessing time: {time.time() - start:.2f}s")
