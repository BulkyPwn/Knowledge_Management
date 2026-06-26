# Bundled ppt-master Runtime Subset

This directory vendors only the ppt-master files used by the LLM Wiki PPT
pipeline at runtime. It is not a full mirror of the upstream skill.

Kept assets:

- `templates/charts/`: chart templates and `charts_index.json`.
- `templates/layouts/`: page layout templates and `layouts_index.json`.
- `templates/icons/`: icon SVGs used by `finalize_svg.py`.
- `templates/*_reference.md`: compact prompt references used by this adapter.
- `scripts/finalize_svg.py` and `scripts/svg_finalize/`: SVG cleanup and icon
  embedding.
- `scripts/svg_quality_checker.py`: generated SVG validation.
- `scripts/svg_to_pptx.py` and `scripts/svg_to_pptx/`: PPTX export.
- `scripts/pptx_to_svg.py` and `scripts/pptx_to_svg/`: source PPTX style
  extraction.
- `scripts/source_to_md/ppt_to_md.py`: source PPTX text extraction.

Removed upstream-only content includes large references, workflow docs, deck and
brand examples, image generation/search, template import, audio, and editor
helpers. `ppt_executor.py` and `ppt_style_extractor.py` prefer this bundled
directory unless `PPT_MASTER_SKILL_DIR` is set.
