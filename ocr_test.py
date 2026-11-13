
import sys
import time
from paddleocr import PaddleOCR

if len(sys.argv) < 2:
    print("Usage: python ocr_test.py image.jpg [korean|es]")
    sys.exit(1)

image_path = sys.argv[1]
language = sys.argv[2].lower() if len(sys.argv) > 2 else "korean"

models = {
    "korean": "korean_PP-OCRv5_mobile_rec",
    "es": "latin_PP-OCRv5_mobile_rec",
}

if language not in models:
    print("Language must be korean or es")
    sys.exit(1)

print(f"Loading {language} OCR model...")

start = time.time()

ocr = PaddleOCR(
    lang=language,
    ocr_version="PP-OCRv5",
    device="cpu",
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name=models[language],
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False
)

print(f"Loaded in {time.time() - start:.2f} seconds")
print("Recognising text...")

start = time.time()
results = ocr.predict(input=image_path)

for result in results:
    result.print()

print(f"Processing time: {time.time() - start:.2f} seconds")
