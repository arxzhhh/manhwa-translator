def group_ocr_regions(result, kept_regions):
    polygons = result.get("rec_polys", [])
    regions = []

    for number, text in kept_regions:
        index = number - 1
        if index >= len(polygons):
            continue

        polygon = polygons[index]
        xs = [float(p[0]) for p in polygon]
        ys = [float(p[1]) for p in polygon]

        regions.append({
            "number": number,
            "text": text.strip(),
            "left": min(xs),
            "right": max(xs),
            "top": min(ys),
            "bottom": max(ys),
        })

    regions.sort(key=lambda r: (r["top"], r["left"]))

    def belongs_together(a, b):
        vertical_gap = max(
            0,
            max(a["top"], b["top"]) -
            min(a["bottom"], b["bottom"])
        )

        height = max(
            a["bottom"] - a["top"],
            b["bottom"] - b["top"],
            1
        )

        overlap = max(
            0,
            min(a["right"], b["right"]) -
            max(a["left"], b["left"])
        )

        min_width = max(
            1,
            min(
                a["right"] - a["left"],
                b["right"] - b["left"]
            )
        )

        return (
            vertical_gap <= max(20, height * 1.5)
            and overlap / min_width >= 0.15
        )

    groups = []

    for region in regions:
        matching = None

        for group in groups:
            if any(belongs_together(region, item) for item in group):
                matching = group
                break

        if matching is None:
            groups.append([region])
        else:
            matching.append(region)

    output = []

    for group in groups:
        group.sort(key=lambda r: (r["top"], r["left"]))

        output.append({
            "region_numbers": [r["number"] for r in group],
            "text": " ".join(r["text"] for r in group),
        })

    return output
