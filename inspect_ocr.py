import sys
from auto_translate import create_ocr, extract_text, detect_language

if len(sys.argv) < 2:
    print("Usage: python inspect_ocr.py image.png")
    sys.exit(1)

image_path = sys.argv[1]

print("Running Korean OCR...")
ocr = create_ocr("korean_PP-OCRv5_mobile_rec")

result = ocr.predict(input=image_path)[0]
texts = extract_text(result)

language = detect_language(texts)
print("Detected language:", language)

del ocr

if language == "spanish":
    print("Running Spanish OCR...")
    ocr = create_ocr("latin_PP-OCRv5_mobile_rec")
    result = ocr.predict(input=image_path)[0]
    del ocr

print("\nAvailable OCR fields:")
for key in result.keys():
    print("-", key)

print("\nText regions and coordinates:")

texts = result.get("rec_texts", [])
polys = result.get("rec_polys", [])
boxes = result.get("rec_boxes", [])

for i, text in enumerate(texts):
    print(f"\nRegion {i + 1}: {text}")

    if i < len(polys):
        print("Polygon:", polys[i])

    if i < len(boxes):
        print("Bounding box:", boxes[i])

print("\nInspection complete.")
