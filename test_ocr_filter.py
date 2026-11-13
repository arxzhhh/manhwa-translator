import cv2
from paddleocr import PaddleOCR
from ocr_filter import filter_ocr_regions

image_path = "/home/anthony/Downloads/korean2.png"
image = cv2.imread(image_path)

ocr = PaddleOCR(
    device="cpu",
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="latin_PP-OCRv5_mobile_rec",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
)

result = ocr.predict(input=image_path)[0]

print("\nTEXT KEPT FOR TRANSLATION")
print("=" * 40)

kept = filter_ocr_regions(result, image.shape)

for number, text in kept:
    print(f"{number:02d}. {text}")

print("\nFILTER TEST COMPLETE")
