---
layout_id: huawei_standard
kind: layout
summary: Huawei-style corporate reports, technology briefings, proposals, and executive updates.
canvas_format: ppt169
page_count: 5
page_types: [cover, toc, chapter, content, ending]
primary_color: "#C7000B"
---

# Huawei Standard - Design Specification

## Template Overview

Light corporate presentation system derived from the supplied Huawei 16:9 reference. It uses restrained Huawei red accents, generous white space, neutral gray information fields, and photographic covers. All generated text remains editable.

## Color and Typography

- Background: `#FFFFFF`; secondary field: `#F5F5F5`
- Primary: `#C7000B`; secondary red: `#EA5A4F`; sparing highlight: `#FBAE40`
- Text: `#1D1D1B`; secondary text: `#666666`; border: `#DDDDDD`
- Chinese: Microsoft YaHei; Latin: Arial
- Never replace the primary red with arbitrary bright red or a dark-tech palette.

## Signature Elements

- A short Huawei-red rule or vertical bar anchors every title.
- Cover and ending pages may use approved files from `images/`; preserve their exact relative href.
- Content pages are white, with a compact title band, broad editable content field, thin footer rule, compact logo, and page number.
- Charts use the ordered palette `#C7000B`, `#EA5A4F`, `#FBAE40`, `#78000F`, `#898989`; avoid rainbow palettes.
- Do not emit `Huawei Confidential`, stale copyright years, or sample data from the source deck.

## Page Roster

| File | Role | Purpose |
|---|---|---|
| `01_cover.svg` | cover | Photographic hero cover with editable title and metadata |
| `02_toc.svg` | toc | Four-section agenda grid |
| `02_chapter.svg` | chapter | Section divider derived from the source visual language |
| `03_content.svg` | content | General corporate content and chart scaffold |
| `04_ending.svg` | ending | Photographic closing page with editable message |

## Asset Rules

At runtime the `images/` directory is copied beside generated SVG files. Keep image hrefs relative, for example `images/cover-explore.png`. Images are backgrounds or logos only; titles, dates, sources, page numbers, and body content must remain SVG text and shapes.
