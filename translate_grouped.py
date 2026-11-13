import sys
import gc
import re
import cv2
import json

from contextlib import redirect_stdout
from pathlib import Path

from auto_translate import create_ocr, detect_language
from ocr_filter import filter_ocr_regions
from text_grouping import group_ocr_regions
from translation_engine import TranslationEngine


def log(message):
    print(message, file=sys.stderr, flush=True)


def repair_split_words(text):
    """Rejoin words split by OCR at the end of a line."""
    return re.sub(
        r"-\s+(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])",
        "",
        text
    )


def is_meaningful_text(text):
    """Discard standalone decorative symbols and punctuation."""
    return any(char.isalpha() or char.isdigit() for char in text)


def get_region_details(result, kept_regions):
    """Return recognised regions with polygon and bounding-box coordinates."""
    polygons = result.get("rec_polys", [])
    scores = result.get("rec_scores", [])

    regions = []

    for number, text in kept_regions:
        index = number - 1

        if index < 0 or index >= len(polygons):
            continue

        polygon = polygons[index]

        points = [
            [float(point[0]), float(point[1])]
            for point in polygon
        ]

        xs = [point[0] for point in points]
        ys = [point[1] for point in points]

        confidence = (
            float(scores[index])
            if index < len(scores)
            else None
        )

        regions.append({
            "region_id": number,
            "text": text,
            "confidence": confidence,
            "polygon": points,
            "bounds": {
                "x": min(xs),
                "y": min(ys),
                "width": max(xs) - min(xs),
                "height": max(ys) - min(ys)
            }
        })

    return regions


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "status": "error",
            "error": "No image path supplied."
        }))
        return 1

    image_path = Path(sys.argv[1]).resolve()

    image = cv2.imread(str(image_path))

    if image is None:
        print(json.dumps({
            "status": "error",
            "error": "Could not open image.",
            "image_path": str(image_path)
        }))
        return 1

    image_height, image_width = image.shape[:2]

    try:
        # Keep OCR and model diagnostic messages out of JSON stdout.
        with redirect_stdout(sys.stderr):

            log("Running OCR...")

            ocr = create_ocr("korean_PP-OCRv5_mobile_rec")
            result = ocr.predict(input=str(image_path))[0]

            language = detect_language(
                result.get("rec_texts", [])
            )

            del ocr
            gc.collect()

            if language == "spanish":
                log("Running Spanish recognition...")

                ocr = create_ocr("latin_PP-OCRv5_mobile_rec")
                result = ocr.predict(input=str(image_path))[0]

                del ocr
                gc.collect()

            log(f"Detected language: {language}")

            kept = filter_ocr_regions(
                result,
                image.shape
            )

            # Remove standalone symbols such as decorative arrows.
            kept = [
                (number, text)
                for number, text in kept
                if is_meaningful_text(text)
            ]

            groups = group_ocr_regions(result, kept)

            regions = get_region_details(result, kept)

            region_lookup = {
                region["region_id"]: region
                for region in regions
            }

            passages = []

            for index, group in enumerate(groups, 1):
                original_text = repair_split_words(
                    group["text"]
                )

                passage_regions = [
                    region_lookup[number]
                    for number in group["region_numbers"]
                    if number in region_lookup
                ]

                passages.append({
                    "passage_id": index,
                    "original_text": original_text,
                    "translated_text": None,
                    "region_ids": group["region_numbers"],
                    "regions": passage_regions
                })

            del result, kept, groups
            gc.collect()

            log(f"Found {len(passages)} dialogue passages.")

            if passages:
                log("Loading translation engine...")

                engine = TranslationEngine()

                translations = engine.translate_many(
                    [passage["original_text"] for passage in passages],
                    language,
                    batch_size=2
                )

                for passage, translated in zip(passages, translations):
                    passage["translated_text"] = translated

                del engine
                gc.collect()

        response = {
            "status": "success",
            "source_language": language,
            "target_language": "english",
            "image": {
                "filename": image_path.name,
                "width": image_width,
                "height": image_height
            },
            "region_count": len(regions),
            "passage_count": len(passages),
            "regions": regions,
            "passages": passages
        }

        print(json.dumps(
            response,
            ensure_ascii=False
        ))

        return 0

    except Exception as error:
        log(f"Translation error: {error}")

        print(json.dumps({
            "status": "error",
            "error": str(error)
        }))

        return 1


if __name__ == "__main__":
    sys.exit(main())
