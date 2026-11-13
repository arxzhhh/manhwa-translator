import sys
import gc
import cv2

from auto_translate import create_ocr, detect_language
from ocr_filter import filter_ocr_regions
from text_grouping import group_ocr_regions


if len(sys.argv) < 2:
    print("Usage: python test_grouping.py image.png")
    sys.exit(1)

image_path = sys.argv[1]
image = cv2.imread(image_path)

if image is None:
    print("Could not open image:", image_path)
    sys.exit(1)

print("Running OCR...")

ocr = create_ocr("korean_PP-OCRv5_mobile_rec")
result = ocr.predict(input=image_path)[0]

language = detect_language(result.get("rec_texts", []))
del ocr
gc.collect()

if language == "spanish":
    ocr = create_ocr("latin_PP-OCRv5_mobile_rec")
    result = ocr.predict(input=image_path)[0]
    del ocr
    gc.collect()

print("Detected language:", language)

kept = filter_ocr_regions(result, image.shape)
groups = group_ocr_regions(result, kept)

print("\nGROUPED TEXT")
print("=" * 45)

for i, group in enumerate(groups, 1):
    print(f"\nPassage {i} (regions {group['region_numbers']}):")
    print(group["text"])

print("\nGrouping test complete.")
