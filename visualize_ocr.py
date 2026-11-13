import sys
import gc
import cv2

from auto_translate import create_ocr, extract_text, detect_language


def main():

    if len(sys.argv) < 2:
        print("Usage: python visualize_ocr.py image.png")
        return

    image_path = sys.argv[1]

    image = cv2.imread(image_path)

    if image is None:
        print("Could not open image:", image_path)
        return

    print("Image dimensions:", image.shape[1], "x", image.shape[0])

    print("Running Korean OCR...")
    ocr = create_ocr("korean_PP-OCRv5_mobile_rec")

    result = ocr.predict(input=image_path)[0]
    texts = extract_text(result)

    language = detect_language(texts)

    del ocr
    gc.collect()

    print("Detected language:", language)

    if language == "spanish":
        print("Running Spanish OCR...")
        ocr = create_ocr("latin_PP-OCRv5_mobile_rec")
        result = ocr.predict(input=image_path)[0]
        del ocr
        gc.collect()

    polygons = result.get("rec_polys", [])
    texts = result.get("rec_texts", [])
    scores = result.get("rec_scores", [])

    print("\nDrawing", len(texts), "regions...")

    for i, (text, polygon) in enumerate(zip(texts, polygons)):

        points = polygon.astype("int32").reshape((-1, 1, 2))

        cv2.polylines(
            image,
            [points],
            True,
            (0, 180, 255),
            2
        )

        x = int(polygon[:, 0].min())
        y = int(polygon[:, 1].min())

        cv2.putText(
            image,
            str(i + 1),
            (x, max(20, y - 5)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 0, 255),
            2
        )

        score = float(scores[i]) if i < len(scores) else 0

        print(
            f"{i + 1:02d}. {text} "
            f"(confidence: {score:.3f})"
        )

    output_path = image_path.rsplit(".", 1)[0] + "_ocr_debug.jpg"

    cv2.imwrite(output_path, image)

    print("\nSaved annotated image:")
    print(output_path)


if __name__ == "__main__":
    main()
