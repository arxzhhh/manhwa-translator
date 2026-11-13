import sys
import gc

from auto_translate import create_ocr, extract_text, detect_language
from translation_engine import TranslationEngine


def clean_lines(lines):
    cleaned = []

    for line in lines:
        line = str(line).strip()

        # Remove obvious OCR noise.
        if len(line) < 3:
            continue

        if ".NET" in line.upper() or ".COM" in line.upper():
            continue

        if line.isdigit():
            continue

        cleaned.append(line)

    return cleaned


def join_lines(lines):
    result = ""

    for line in lines:
        if not result:
            result = line
        elif result.endswith("-"):
            result = result[:-1] + line
        else:
            result += " " + line

    return result


def main():

    if len(sys.argv) < 2:
        print("Usage: python context_test.py image.png")
        return

    image_path = sys.argv[1]

    print("Loading Korean OCR...")
    korean_ocr = create_ocr(
        "korean_PP-OCRv5_mobile_rec"
    )

    first_result = korean_ocr.predict(
        input=image_path
    )[0]

    first_text = extract_text(first_result)
    language = detect_language(first_text)

    del first_result
    del korean_ocr
    gc.collect()

    print("Detected language:", language)

    if language == "spanish":
        print("Loading Spanish OCR...")

        latin_ocr = create_ocr(
            "latin_PP-OCRv5_mobile_rec"
        )

        result = latin_ocr.predict(
            input=image_path
        )[0]

        lines = extract_text(result)

        del result
        del latin_ocr
        gc.collect()

    else:
        lines = first_text

    lines = clean_lines(lines)
    combined_text = join_lines(lines)

    print("\nCombined source text:")
    print(combined_text)

    print("\nLoading translation engine...")
    engine = TranslationEngine()

    print("\nTranslating complete passage...")

    translation = engine.translate(
        combined_text,
        language
    )

    print("\n" + "=" * 45)
    print("CONTEXT-AWARE TRANSLATION TEST")
    print("=" * 45)
    print(translation)


if __name__ == "__main__":
    main()
