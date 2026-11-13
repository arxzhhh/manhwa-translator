import re
import numpy as np

# Matches domains and URLs, including scanlation site addresses.
DOMAIN_PATTERN = re.compile(
    r"(?:https?://)?(?:www\.)?"
    r"[a-z0-9-]+(?:\.[a-z0-9-]+)+",
    re.IGNORECASE
)

# Promotional phrases that may appear independently of a URL.
PROMO_PATTERN = re.compile(
    r"\b(?:read\s+(?:more\s+)?(?:at|on)|"
    r"lee\s+antes\s+en|"
    r"visit\s+us|"
    r"follow\s+us|"
    r"read\s+at|"
    r"scanlation)\b",
    re.IGNORECASE
)


def filter_ocr_regions(result, image_shape, min_confidence=0.45):
    """
    Remove website promotions, nearby watermark fragments,
    page numbers and very low-confidence OCR noise.

    Returns:
        A list of (original_region_number, recognised_text).
    """

    texts = result.get("rec_texts", [])
    polygons = result.get("rec_polys", [])
    scores = result.get("rec_scores", [])

    height, width = image_shape[:2]
    regions = []

    for i, text in enumerate(texts):
        if i >= len(polygons):
            continue

        polygon = np.asarray(polygons[i]).reshape(-1, 2)
        centre_x = float(polygon[:, 0].mean())
        centre_y = float(polygon[:, 1].mean())

        confidence = float(scores[i]) if i < len(scores) else 1.0

        regions.append({
            "index": i,
            "text": str(text).strip(),
            "x": centre_x,
            "y": centre_y,
            "confidence": confidence,
        })

    # Find website addresses and explicit promotional text.
    promotion_anchors = []

    for region in regions:
        if (
            DOMAIN_PATTERN.search(region["text"])
            or PROMO_PATTERN.search(region["text"])
        ):
            promotion_anchors.append(region)

    # Remove the website address and nearby fragments belonging
    # to the same visual watermark.
    removed = set()

    for anchor in promotion_anchors:
        removed.add(anchor["index"])

        for region in regions:
            dx = abs(region["x"] - anchor["x"])
            dy = abs(region["y"] - anchor["y"])

            nearby = (
                dx <= max(70, width * 0.18)
                and dy <= max(45, height * 0.08)
            )

            if nearby:
                removed.add(region["index"])

    # Remove weak OCR noise and isolated page numbers.
    for region in regions:
        text = region["text"]

        if region["confidence"] < min_confidence:
            removed.add(region["index"])
            continue

        # Standalone page numbers are not dialogue.
        if re.fullmatch(r"[\d\s]+", text):
            removed.add(region["index"])

    return [
        (region["index"] + 1, region["text"])
        for region in regions
        if region["index"] not in removed
    ]
