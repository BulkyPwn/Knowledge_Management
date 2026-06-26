"""
PPT Executor Module — Direct SVG generation & export without Chrys.

Replaces Chrys ppt-master Step 6 (Executor) and Step 7 (Post-processing).
Uses the backend LLM to generate SVGs page-by-page, then calls ppt-master
scripts (finalize_svg.py, svg_to_pptx.py) directly for post-processing.

Usage:
    from ppt_executor import generate_ppt

    result = generate_ppt(
        final_outline=outline_text,
        intent=intent_dict,
        template="default",
        task_dir="/path/to/project",
        on_progress=callback,
    )
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, List, Dict, Any

import requests

# ---------------------------------------------------------------------------
# Mode presets — narrative skeletons (embedded from ppt-master references/modes/)
# ---------------------------------------------------------------------------
_MODE_PRESETS = {
    "pyramid": {
        "name": "pyramid",
        "label": "金字塔结论先行",
        "content": """
## Mode: pyramid — 结论先行 · MECE论证
Conclusion-first argumentation. State the answer, then support with mutually-exclusive,
collectively-exhaustive evidence. Every number carries a comparison.

**Narrative skeleton**: SCQA opening → MECE body → action close
  - Situation: shared context (cover / first 1-2 pages)
  - Complication: tension / problem (early pages)
  - Question: implicit question to resolve (transition)
  - Answer: recommendation developed MECE (all body pages)

**Title voice**: ASSERTION titles, not topic labels.
  Weak: "Market Overview" → Strong: "Domestic market grows 23% YoY, outpacing global average"

**Page-structure**: Title=conclusion → one-line takeaway → supporting evidence beneath.
  Each body page answers one question and states its own one-sentence conclusion.

**Speaker notes**: Conclusion-driven. First sentence = takeaway, then 2-3 supporting facts.
  Composed, authoritative. Every number paired with its comparison.
""",
    },
    "narrative": {
        "name": "narrative",
        "label": "故事叙述",
        "content": """
## Mode: narrative — 情境 → 冲突 → 解决
Story arc: situation → tension → resolution. Suspense and turns. For pitches,
case studies, brand journeys, fundraising.

**Narrative skeleton**: Setup → Rising action → Climax → Resolution
  Pages trace a deliberate emotional and logical arc. Create questions unanswered
  until a few pages later. Use cliffhangers at page ends.

**Title voice**: Story beats, not bullet lists. Titles carry the plot forward.
  "The moment everything changed" not "Pivot Timeline".

**Page-structure**: Each page is a scene. Opening hook → body development → 
  bridge to next. Vary page density — some pages are images carrying the weight.

**Speaker notes**: Conversational, naturally paced. Build suspense ("But then..."),
  use metaphors, rhetorical questions. Like talking through a story, not reading a report.
""",
    },
    "briefing": {
        "name": "briefing",
        "label": "中性简报",
        "content": """
## Mode: briefing — 中性完整 · 可扫描
Neutral, complete, scannable. Topic titles, even weight. No thesis —
inform, don't persuade. For status updates, reference decks, catalogs,
meeting packs, FAQs.

**Narrative skeleton**: Topic sections in logical order. No argument arc.
  Each section stands alone. Flat, equal weight across pages.

**Title voice**: TOPIC titles, neutral and scannable. "Q3 Revenue Breakdown",
  "Team Org Chart", "Project Timeline". No assertion needed.

**Page-structure**: Information-first. Tables, lists, clear sections. 
  Self-contained — each page is a standalone reference card.

**Speaker notes**: Clinical, matter-of-fact. Facts in natural reading order.
  No persuasion, no suspense. Just the information clearly stated.
""",
    },
}


# ---------------------------------------------------------------------------
# Visual style presets — embedded from ppt-master references/visual-styles/
# ---------------------------------------------------------------------------
_VISUAL_STYLE_PRESETS = {
    "dark-tech": {
        "name": "dark-tech",
        "label": "暗色科技",
        "content": """
## Visual Style: dark-tech
Dark canvas, luminous accents, geometric precision. For tech, AI, data products.

**Shape & decoration**: Crisp geometry; thin glowing rules; hexagon/circuit/grid motifs
used sparingly. Slight rounding (rx 4-8) or sharp. Glow accents, fine grid backgrounds,
monospace labels, node/connector lines. Restrained — precision over clutter.

**Whitespace**: Dark negative space reads as depth; let elements float on it.

**Typography**: Clean sans for body; monospace for labels/figures/code cues.
High-contrast hierarchy against the dark field.

**Color usage**: Dark background; one or two luminous accents carry focus;
everything else low-key. Accent does the work of attention — few points, high contrast.

**Texture**: Depth via glow and layering on dark, not drop shadows.
Outer glow / light strokes mark elevation; gradients stay same-hue and subtle.
""",
    },
    "swiss-minimal": {
        "name": "swiss-minimal",
        "label": "瑞士极简",
        "content": """
## Visual Style: swiss-minimal
Strict Swiss-grid discipline. Modular grid, sharp geometry, aggressive whitespace,
near-zero decoration. For high-end consulting, architecture, type-led decks.

**Shape & decoration**: Sharp rectangles, true circles, single-weight rules.
Corner radius rx="0" by default; ≤4 if rounding at all. NO decoration — no gradients,
no decorative blocks, no badges. Structure carries the page. Layout snaps to a visible
or implied modular grid; rigorous column/row alignment.

**Whitespace**: Vast and deliberate; negative space carries as much weight as content.
Wide margins, generous gutters.

**Typography**: Sans-serif, single family; weight contrast (900/300) over family contrast.
Strong size hierarchy — large headlines, small precise body. Left-aligned, flush.

**Color usage**: One color dominates a deliberate grid zone; field stays near-white;
accent appears at a single point — never more than a few percent of canvas.
Color as conceptual zone, not decoration. NO gradients.

**Texture**: Strictly flat. No shadows, no depth, no material — 2D conceptual planes only.
""",
    },
    "soft-rounded": {
        "name": "soft-rounded",
        "label": "柔和圆角",
        "content": """
## Visual Style: soft-rounded
Rounded cards, gentle elevation, approachable. For product, SaaS, training, consumer.

**Shape & decoration**: Generous rounding (rx 12-16). Soft pill shapes for tags/badges.
Gentle drop shadows for card elevation (shared-standards §6). Friendly, accessible.

**Typography**: Rounded or humanist sans. Warm, approachable proportions. Slightly larger body.

**Color usage**: Warm, inviting palette. Pastel or muted primaries. Soft gradients welcome.

**Texture**: Gentle depth — cards float above a light field with subtle shadow.
""",
    },
    "editorial": {
        "name": "editorial",
        "label": "编辑出版",
        "content": """
## Visual Style: editorial
Magazine hierarchy, rules & columns, serif/sans interplay.
For finance, journalism, analysis, explainers.

**Shape & decoration**: Hairline rules (0.5-1px), strict columns, running heads.
No decorative elements — typography IS the decoration. Drop caps, pull quotes.

**Typography**: Serif + sans pairing essential. Generous line-height (1.5-1.6x).
Multi-column text blocks. Responsive size hierarchy.

**Color usage**: Muted, sophisticated palette. Rich dark text on light field.
One accent color for pull quotes / data highlights. No gradients.

**Texture**: Flat, paper-like. Ink on page feel. No material depth.
""",
    },
    "sketch-notes": {
        "name": "sketch-notes",
        "label": "手绘笔记",
        "content": """
## Visual Style: sketch-notes
Warm hand-drawn sketchnote — soft paper field, black ink doodle line work, gentle
pastel blocks. The most approachable style. For education, training, onboarding.

**Shape & decoration**: Rounded shapes with slight wobble; pastel block fills that
slightly overshoot outlines (hand-painted feel); simple cartoon icons. Small doodles
— stars, sparkles, dots, underlines — for warmth; wavy hand-drawn arrows connecting
ideas. Airy and well-organized; generous gaps keep it friendly, never dense.

**Typography**: Friendly hand-lettered / humanist character for titles; clean humanist
body. Warmth over corporate severity.

**Color usage**: Soft paper field; gentle pastel tints, never high-chroma or rainbow.
One accent reserved for a key arrow or emphasis. Generous but gentle.

**Texture**: Flat 2D — intentionally flat. Optional subtle paper grain for warmth;
no drop shadows.
""",
    },
    "ink-notes": {
        "name": "ink-notes",
        "label": "墨水白板",
        "content": """
## Visual Style: ink-notes
Whiteboard-ink minimalism — pale field, confident black hand-ink line work, sparse
semantic color. Considered and manifesto-clear. For methodology, before/after essays,
mindset-shift narratives, technical manifestos.

**Shape & decoration**: Hand-drawn line work with slight intentional wobble — boxes,
arrows, dividers sketched as on a thoughtful whiteboard; never mechanically straight.
Line defines structure; no filled cards. Minimal decoration — a few doodle marks for
emphasis. Restraint IS the look.

**Typography**: Hand-lettered / humanist titles — bold, slightly oversized, confident.
Plain legible sans body. Reads as written-by-hand-but-deliberate.

**Color usage**: Near-monochrome: ink-dark line work on a pale field does ~85% of work;
accent appears only as semantic mark (risk/positive/highlight) under ~10% of canvas.
Color carries meaning, not decoration.

**Texture**: Strictly flat — no shadows, no paper grain. Depth reads from line weight
and spacing alone.
""",
    },
    "chalkboard": {
        "name": "chalkboard",
        "label": "黑板粉笔",
        "content": """
## Visual Style: chalkboard
Classroom chalkboard — dark slate field, soft chalk-stroke line work, powdery pastel
accents. Nostalgic and instructional. For teaching decks, tutorials, academic content.

**Shape & decoration**: Chalk-stroke line work with slightly diffused, dry-medium edges;
sketched boxes, brackets, arrows in chalk. Confident but never mechanical. Underlines
and emphasis marks; scattered chalk stars / dots. Blackboard pedagogy — organized
sections, clear central focus. The dark board reads as room; let chalk marks breathe.

**Typography**: Hand-lettered chalk character for titles; legible body. Dry, nostalgic,
classroom-warm.

**Color usage**: Dark slate field; off-white chalk carries most marks; deck colors
appear as soft powdery pastel chalk accents, used sparingly. Restrained — never
saturated fills.

**Texture**: Flat — depth from chalk-stroke weight, not material. Chalk-dust grain
texture across the board is on-brand; no drop shadows.
""",
    },
    "ink-wash": {
        "name": "ink-wash",
        "label": "水墨国风",
        "content": """
## Visual Style: ink-wash
New-Chinese ink-wash — rice-paper field, vast literati whitespace, restrained brush
marks, a single seal-stamp accent. Still, considered, Eastern. For cultural topics,
philosophy, heritage, 新中式 narratives.

**Shape & decoration**: Minimal brush-stroke marks and hairline dividers; occasional
ink-dark block; a single seal-stamp (印章) square as focal accent. No cards, no boxes
— emptiness IS the structure. Almost no decoration; what appears reads as brush and
seal. Asymmetric, scroll-like composition with deliberate off-balance.

**Typography**: Brush / serif character for titles (calligraphic, expressive) against
clean modern sans body — Kai × Hei contrast axis. Large airy titles, generous leading.

**Color usage**: Pale rice-paper field dominates; ink-dark carries type and rare ink
shape; a single warm seal-red accent at one key point. Near-monochrome ink discipline
— restraint is the aesthetic.

**Texture**: Flat — emptiness and brush weight carry depth, not shadow. Optional faint
paper grain or low-opacity ink-bleed wash; no drop shadows.
""",
    },
    "glassmorphism": {
        "name": "glassmorphism",
        "label": "毛玻璃",
        "content": """
## Visual Style: glassmorphism
Frosted-glass SaaS — translucent layered panels, flowing gradient light, floating depth
on a dark field. Premium, future-tech. For modern SaaS, fintech, health-tech, product
launches, AI demos.

**Shape & decoration**: Rounded translucent glass panels (low fill-opacity over dark
field) with bright hairline edges; layered floating cards; rounded corners (rx 12-20).
Soft radial light blooms in background; thin luminous edge highlights. The glass
material IS the decoration, not added ornament.

**Typography**: Clean modern sans; light / medium weights; airy. Headlines can carry
luminous gradient on the dark field.

**Color usage**: Dark field; colors read as luminous gradients flowing across panels
and titles, low-opacity glass tints, neon accent at ~10%. Color behaves like light
through glass. Depth from how brightly glass glows, not heavy saturation.

**Texture**: Depth via translucency, layering, bright edge highlights, soft background
glow — not hard drop shadows. Smooth multi-stop gradients are intrinsic here (the one
style where generous gradient use is on-brand); keep them luminous, not muddy.
""",
    },
    "blueprint": {
        "name": "blueprint",
        "label": "工程蓝图",
        "content": """
## Visual Style: blueprint
Engineering schematic — thin line work on dark blueprint paper, isometric projection,
technical-annotation language. Speaks like a drawing hung on a wall. For architecture
walkthroughs, technical briefings, engineering whitepapers, systems explainers.

**Shape & decoration**: Thin single-weight line frames (no heavy fills); components as
outlined geometry; optional isometric / 3D-axonometric projection. Slight or zero corner
rounding. Engineering-drawing vocabulary — dimension lines, leader arrows, component
codes, coordinate labels, faint gridline backdrop. Annotation IS the decoration.

**Typography**: Clean sans for labels and body; monospace for component names / codes /
coordinates. Small precise annotation type; wide tracking on coordinate labels.

**Color usage**: Dark paper field; single line-color carries all schematic line work;
one spot accent marks current state / key path / callout. Everything else low-key
line work. Accent at few points, high contrast.

**Texture**: Flat line work, not material elevation. Depth reads from isometric
projection and layered line weights, not shadows. Optional subtle corner vignette /
accent glow on dark paper — keep it faint.
""",
    },
    "huawei-corporate": {
        "name": "huawei-corporate",
        "label": "华为企业",
        "content": """
## Visual Style: huawei-corporate
Corporate communication style for technology briefings, executive updates, 
and structured proposals. Light-field with restrained red accent identity, 
photographic hero images, and clear information hierarchy.

**Shape & decoration**: Clean rectangles with modest rounding (rx=4-8). 
A single thin accent bar (2-4px, primary red) anchors the header zone. 
A small L-shaped decorative mark is permitted near the title — keep it 
subtle, geometric, and monochrome-neutral. Title underline rules are 2px.

**Whitespace**: Professional breathing room — tighter than Swiss minimal, 
looser than dense editorial. 50-60px margins. 20-28px gutters between cards. 
Content blocks are clearly separated by negative space or 1px neutral rules.

**Typography**: Sans-serif, single family paired (Arial + Microsoft YaHei).
Weight contrast is restrained (700/400); no extreme weight differences.
Titles are sentence case or clean Chinese titles — no all-caps shouting.
Left-aligned with consistent vertical rhythm: line-height 1.4-1.6.

**Color usage**: Light field (#FFFFFF or #F5F5F5). Primary red (#C7000B) 
appears as thin accent bars, action icons, category markers — never more 
than 5-8% of canvas. Amber (#FBAE40) highlights key data points or KPI 
values. Text is dark (#1D1D1B), secondary text is medium gray (#666666). 
Background images (supplied as template assets) MAY be used as full-bleed 
hero photos on covers and chapter dividers. Content pages stay clean white 
or light gray with no photo backgrounds.

**Texture**: Flat with subtle depth. Cards use minimal drop shadow 
(opacity 0.04-0.08) or 1px border. No gradients on content pages. 
Cover hero images provide the only visual texture — content pages 
stay crisp and flat.
""",
    },
}


def _select_mode(intent: dict) -> str:
    """Auto-select narrative mode based on topic/audience/scenario signals."""
    topic = (intent or {}).get("topic", "")
    audience = (intent or {}).get("audience", "")
    scenario = (intent or {}).get("scenario", "")

    combined = f"{topic} {audience} {scenario}".lower()

    pyramid_signals = ["决策", "分析", "战略", "board", "executive", "investor",
                       "汇报", "评估", "评测", "benchmark", "对比", "选型", "方案"]
    narrative_signals = ["路演", "故事", "案例", "pitch", "品牌", "融资",
                         "fundraising", "journey", "历程", "故事"]
    briefing_signals = ["周报", "日报", "月报", "参考", "status", "faq",
                        "目录", "catalog", "手册", "百科", "知识库"]

    if any(s in combined for s in narrative_signals):
        return "narrative"
    if any(s in combined for s in briefing_signals):
        return "briefing"
    return "briefing"  # default


def _select_visual_style(intent: dict, ref_theme: str = "dark") -> str:
    """Auto-select visual style based on topic/industry signals."""
    topic = (intent or {}).get("topic", "")
    scenario = (intent or {}).get("scenario", "")
    combined = f"{topic} {scenario}".lower()

    tech_signals = ["ai", "技术", "tech", "模型", "算法", "数据", "代码", "dev",
                    "编程", "架构", "系统", "deepseek", "gpt", "llm", "ml"]
    consulting_signals = ["咨询", "consulting", "战略", "strategy", "方案", "规划",
                          "麦肯锡", "mbb", "架构", "architecture"]
    product_signals = ["产品", "product", "saas", "app", "设计", "design",
                       "用户体验", "ux", "培训", "training"]
    glass_signals = ["金融科技", "fintech", "健康科技", "health-tech", "glassmorphism",
                     "premium", "发布", "launch", "演示", "demo", "现代", "modern"]
    blueprint_signals = ["工程", "架构", "系统", "系统设计", "engineering",
                         "schematic", "blueprint", "white-paper", "白皮书-工程"]
    editorial_signals = ["报告", "report", "分析", "analysis", "财经", "金融",
                         "finance", "白皮书", "whitepaper"]
    education_signals = ["教育", "培训", "学习", "教程", "onboarding", "course"]
    chalkboard_signals = ["课堂", "教学", "黑板", "tutorial", "academic", "academy"]
    cultural_signals = ["文化", "哲学", "书法", "国风", "新中式", "水墨", "东方", "禅",
                        "传统", "heritage", "calligraphy", "philosophy"]

    if any(s in combined for s in editorial_signals):
        return "editorial"
    if any(s in combined for s in cultural_signals):
        return "ink-wash"
    if any(s in combined for s in glass_signals):
        return "glassmorphism"
    if any(s in combined for s in chalkboard_signals):
        return "chalkboard"
    if any(s in combined for s in education_signals):
        return "sketch-notes"
    if any(s in combined for s in blueprint_signals):
        return "blueprint"
    if any(s in combined for s in consulting_signals):
        return "swiss-minimal"
    if any(s in combined for s in product_signals):
        return "soft-rounded"
    if any(s in combined for s in tech_signals):
        return "dark-tech"
    return "dark-tech" if ref_theme == "dark" else "swiss-minimal"


def _get_mode_content(mode_name: str) -> str:
    """Get embedded mode content for Executor prompt injection."""
    preset = _MODE_PRESETS.get(mode_name)
    return preset["content"] if preset else _MODE_PRESETS["briefing"]["content"]


def _get_visual_style_content(style_name: str) -> str:
    """Get embedded visual style content for Executor prompt injection."""
    preset = _VISUAL_STYLE_PRESETS.get(style_name)
    return preset["content"] if preset else _VISUAL_STYLE_PRESETS["dark-tech"]["content"]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LLM_REQ_TIMEOUT_NORMAL_SECONDS = 300   # ≤300s LLM requests → unified to 300s
LLM_REQ_TIMEOUT_MAX_SECONDS = 1200     # >600s LLM requests → unified to 1200s

LLM_TEMPERATURE_SVG = 0.3      # low temp for consistent SVG output
LLM_TEMPERATURE_CREATIVE = 0.5 # medium temp for spec/notes generation
LLM_MAX_TOKENS_SVG = 32768     # enough for complex SVG pages
LLM_MAX_TOKENS_SPEC = 8192     # enough for design_spec.md
LLM_MAX_TOKENS_NOTES = 4096    # enough for speaker notes

SVG_QUALITY_MAX_RETRIES = 3    # max retries when SVG checker reports errors
SVG_GENERATION_MAX_RETRIES = 2 # max retries per page on LLM failure
SVG_GENERATION_MAX_WORKERS = int(os.environ.get("PPT_SVG_MAX_WORKERS", "8"))  # parallel page generation
SVG_CONCURRENCY_MIN = 1  # minimum concurrency after adaptive backoff
PPT_TEMPLATE_CONTEXT_MAX_CHARS = int(os.environ.get("PPT_TEMPLATE_CONTEXT_MAX_CHARS", "18000"))
PPT_TEMPLATE_CONTEXT_SIMPLIFIED_MAX_CHARS = int(os.environ.get("PPT_TEMPLATE_CONTEXT_SIMPLIFIED_MAX_CHARS", "3000"))

def _default_ppt_master_dir() -> str:
    """Prefer the bundled ppt-master assets, fall back to the user-installed skill."""
    local_dir = os.path.join(os.path.dirname(__file__), "ppt_master")
    if os.path.isdir(local_dir):
        return local_dir
    return os.path.join(os.environ.get("APPDATA", ""), "chrys", "skills", "ppt-master")


# ppt-master skill/assets directory (where scripts/templates live)
SKILL_DIR = os.environ.get("PPT_MASTER_SKILL_DIR", _default_ppt_master_dir())

# ---------------------------------------------------------------------------
# Visual style → icon library mapping
# ---------------------------------------------------------------------------
# Each visual_style has a natural icon library affinity:
#   dark backgrounds → filled (solid + glow visibility)
#   light backgrounds → outline (lightweight, clean)
#   sharp/architectural → chunk-filled (rectilinear geometry)
_VISUAL_STYLE_TO_ICON_LIBRARY = {
    "dark-tech": "tabler-filled",
    "blueprint": "tabler-filled",
    "glassmorphism": "tabler-filled",
    "chalkboard": "chunk-filled",
    "swiss-minimal": "tabler-outline",
    "huawei-corporate": "tabler-outline",
    "soft-rounded": "tabler-filled",
    "editorial": "tabler-outline",
    "sketch-notes": "chunk-filled",
    "ink-notes": "tabler-outline",
    "ink-wash": "tabler-outline",
}


def _get_icon_library(visual_style: str) -> str:
    """Return the icon library best suited for a given visual style."""
    return _VISUAL_STYLE_TO_ICON_LIBRARY.get(visual_style, "tabler-filled")


# Curated list of commonly useful presentation icons.
# These names exist in at least one of {tabler-filled, tabler-outline, chunk-filled};
# embed_icons.py cross-library fallback handles resolution when the chosen
# library doesn't have every name.
_COMMON_PRESENTATION_ICONS = [
    "chart-bar", "trend-up", "chart-pie", "graph", "database", "server",
    "code", "settings", "rocket", "bulb", "sparkles", "bolt", "shield",
    "target", "layers", "cloud", "globe", "users", "link", "file-text",
    "search", "star", "check", "award", "clock", "alert-triangle", "brain",
    "activity", "thumb-up", "mail", "map-pin", "calendar", "heart", "flag",
    "lock", "download", "upload", "bookmark", "lightbulb", "tools",
]

# ---------------------------------------------------------------------------
# Icon catalog (loaded lazily from filesystem)
# ---------------------------------------------------------------------------

_ICON_CATALOG: Optional[str] = None

def _load_icon_catalog() -> str:
    """Scan icon libraries and build a compact categorized catalog for LLM prompts."""
    global _ICON_CATALOG
    if _ICON_CATALOG is not None:
        return _ICON_CATALOG

    icons_dir = os.path.join(SKILL_DIR, "templates", "icons")
    if not os.path.isdir(icons_dir):
        _ICON_CATALOG = ""
        return ""

    # Category taxonomy: prefix patterns → UI category label
    CATEGORIES = {
        "navigation": ["arrow", "chevron", "caret", "home", "menu", "compass", "direction", "corner", "sign"],
        "actions": ["plus", "minus", "check", "x", "cross", "circle-check", "circle-x", "circle-plus", "circle-minus",
                    "square-check", "square-x", "square-plus", "square-minus", "circle-dot", "dots", "drag-drop",
                    "edit", "pencil", "trash", "copy", "paste", "cut", "clipboard", "link", "unlink",
                    "refresh", "reload", "rotate", "repeat", "upload", "download", "share", "send",
                    "login", "logout", "enter", "exit", "zoom-in", "zoom-out", "scan", "search",
                    "filter", "sort", "switch", "toggle", "eye", "eye-off", "lock", "unlock",
                    "settings", "adjustments", "tools", "wrench", "tool"],
        "media": ["play", "pause", "stop", "skip", "rewind", "forward", "backward", "volume", "mute",
                  "music", "audio", "video", "camera", "photo", "picture", "image", "gallery",
                  "movie", "microphone", "headphones", "speaker", "tv", "monitor", "screen"],
        "communication": ["mail", "message", "chat", "phone", "call", "bell", "notification", "alert",
                          "address-book", "at", "hash", "tag", "label", "bookmark", "flag",
                          "thumb-up", "thumb-down", "star", "heart", "like", "mood", "emoji",
                          "user", "users", "friends", "group", "person", "people"],
        "document": ["file", "folder", "archive", "note", "notes", "notebook", "report", "article",
                     "document", "paper", "certificate", "license", "receipt", "invoice",
                     "template", "script", "code", "terminal", "command", "keyboard"],
        "data": ["chart", "graph", "trending", "stats", "analytics", "dashboard", "diagram",
                 "table", "grid", "list", "timeline", "bar-chart", "pie-chart", "bubble",
                 "database", "server", "cloud", "cpu", "chip", "circuit", "network", "wifi",
                 "bluetooth", "usb", "device", "laptop", "desktop", "tablet", "phone"],
        "commerce": ["shopping", "cart", "bag", "credit-card", "wallet", "coin", "dollar", "euro",
                     "shop", "store", "building", "truck", "package", "box", "gift",
                     "briefcase", "backpack", "calendar", "clock", "alarm", "hourglass",
                     "map", "pin", "location", "globe", "world", "language"],
        "shapes": ["circle", "square", "triangle", "hexagon", "octagon", "diamond", "oval",
                   "rectangle", "pentagon", "cube", "sphere", "cone", "cylinder", "pyramid"],
        "weather": ["sun", "moon", "cloud", "rain", "snow", "wind", "storm", "droplet", "flame",
                    "umbrella", "thermometer", "tornado"],
    }

    def _scan_library(lib_name: str) -> dict:
        """Scan one icon library and group by categories."""
        lib_dir = os.path.join(icons_dir, lib_name)
        if not os.path.isdir(lib_dir):
            return {}
        grouped = {cat: [] for cat in CATEGORIES}
        ungrouped = []
        try:
            files = [f[:-4] for f in os.listdir(lib_dir) if f.endswith(".svg")]
        except Exception:
            return {}
        for name in files:
            matched = False
            for cat, prefixes in CATEGORIES.items():
                if any(name.startswith(p) or name == p for p in prefixes):
                    grouped[cat].append(name)
                    matched = True
                    break
            if not matched:
                ungrouped.append(name)
        # Limit each category to ~15 representative icons
        for cat in grouped:
            grouped[cat] = sorted(set(grouped[cat]))[:15]
        return {"grouped": grouped, "ungrouped": sorted(set(ungrouped))[:20]}

    def _scan_simple_icons() -> str:
        """Simple-icons: sample well-known brand names."""
        lib_dir = os.path.join(icons_dir, "simple-icons")
        if not os.path.isdir(lib_dir):
            return ""
        known = {"github", "gitlab", "google", "microsoft", "apple", "amazon", "facebook",
                 "twitter", "linkedin", "youtube", "slack", "discord", "docker", "kubernetes",
                 "python", "rust", "go", "java", "nodejs", "react", "vue", "angular", "linux",
                 "ubuntu", "debian", "redhat", "nginx", "apache", "mysql", "postgresql",
                 "redis", "mongodb", "elasticsearch", "grafana", "prometheus", "ansible",
                 "terraform", "jenkins", "git", "npm", "yarn", "android", "ios", "windows",
                 "chrome", "firefox", "safari", "edge", "vscode", "intellij", "figma",
                 "notion", "trello", "jira", "confluence", "bitbucket", "vercel", "netlify",
                 "cloudflare", "aws", "azure", "gcp", "openai", "anthropic", "deepseek"}
        try:
            files = {f[:-4] for f in os.listdir(lib_dir) if f.endswith(".svg")}
        except Exception:
            return ""
        existing = sorted(known & files)
        if existing:
            return f"- simple-icons: {', '.join(existing[:30])} ... ({len(files)} brand logos total)"
        return ""

    lines = ["## Icon Library Catalog (data-icon placeholders)"]
    lines.append("Syntax: `<use data-icon=\"LIBRARY/icon-name\" x=\"...\" y=\"...\" width=\"...\" height=\"...\" fill=\"#HEX\"/>`")
    lines.append("")
    lines.append("| Library | Style | Size | Use Case |")
    lines.append("|---|---|---|---|")
    lines.append("| **tabler-outline** | stroke/line | 24×24 | Minimal line icons, light UI |")
    lines.append("| **tabler-filled** | solid fill | 24×24 | Bold filled UI icons |")
    lines.append("| **chunk-filled** | sharp rectilinear | 16×16 | Tech/engineering/enterprise tone |")
    lines.append("| **phosphor-duotone** | duotone | 256×256 | Soft depth for hero spots |")
    lines.append("| **simple-icons** | brand logos | 24×24 | Company/product marks |")
    lines.append("")
    lines.append("**Primary library**: tabler-filled and tabler-outline share identical icon names; choose one style per deck.")
    lines.append("**Naming**: kebab-case, literal visual shape (e.g., `chart-bar`, `shield-check`, `users-group`).")
    lines.append("")

    # Scan tabler-outline (largest library, defines the canonical name set)
    catalog = _scan_library("tabler-outline")
    if catalog.get("grouped"):
        lines.append("### Common Tabler Icons by Category")
        lines.append("*(Same names work for both tabler-outline and tabler-filled)*")
        for cat, icons in catalog["grouped"].items():
            if icons:
                lines.append(f"- **{cat}**: {', '.join(icons)}")
        if catalog.get("ungrouped"):
            lines.append(f"- **other**: {', '.join(catalog['ungrouped'])}")

    # Scan chunk-filled
    chunk = _scan_library("chunk-filled")
    if chunk.get("grouped"):
        lines.append("")
        lines.append("### Common Chunk-Filled Icons")
        lines.append("*(Sharp/rectilinear style — best for engineering/enterprise decks)*")
        flat = []
        for icons in chunk["grouped"].values():
            flat.extend(icons[:5])
        flat = sorted(set(flat))[:30]
        if flat:
            lines.append(f"Samples: {', '.join(flat)}")

    # Phosphor-duotone note
    lines.append("")
    lines.append("### Phosphor-Duotone")
    lines.append("Uses **different naming** from Tabler: `house` (not `home`), `gear` (not `settings`), `user-circle` (not `user-circle`).")
    lines.append("Common: house, gear, user, users, lock, unlock, bell, bookmark, calendar, clock, envelope,")
    lines.append("flag, globe, heart, image, link, map-pin, money, paperclip, phone, printer, rocket,")
    lines.append("shield, star, thumbs-up, trash, trophy, warning, wrench.")

    # Simple-icons
    si = _scan_simple_icons()
    if si:
        lines.append("")
        lines.append("### Simple-Icons (Brand Logos)")
        lines.append(si)

    _ICON_CATALOG = "\n".join(lines)
    return _ICON_CATALOG


def _scan_library_flat(lib_name: str) -> list[str]:
    """Scan an icon library and return all icon names (without .svg suffix).

    Used by _build_spec_lock to get the real, verified list of available icons.
    Unlike _scan_library (which is for LLM prompt catalogs), this returns
    the complete list — no category grouping, no truncation."""
    icons_dir = os.path.join(SKILL_DIR, "templates", "icons")
    lib_dir = os.path.join(icons_dir, lib_name)
    if not os.path.isdir(lib_dir):
        return []
    try:
        return sorted([f[:-4] for f in os.listdir(lib_dir) if f.endswith(".svg")])
    except Exception:
        return []


_refs: Dict[str, Any] = {}
_template_index_cache: Dict[str, Any] = {}

_BUILTIN_TEMPLATE_LAYOUTS = {
    "huawei_standard": "huawei_standard",
}


def init_executor(app_refs: Dict[str, Any]):
    """Inject references from app.py (same pattern as ppt_pipeline.py)."""
    _refs.clear()
    _refs.update(app_refs)


# ---------------------------------------------------------------------------
# LLM helpers (mirror ppt_pipeline.py pattern)
# ---------------------------------------------------------------------------

def _call_llm_detailed(
    system_prompt: str,
    user_msg: str,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    timeout_seconds: int = LLM_REQ_TIMEOUT_NORMAL_SECONDS,
) -> Dict[str, Any]:
    """Call LLM and return content plus diagnostics for debugging long SVG runs."""
    meta = {
        "ok": False,
        "error_type": "",
        "error_message": "",
        "status_code": None,
        "model": "",
        "input_chars": len(system_prompt or "") + len(user_msg or ""),
        "system_prompt_chars": len(system_prompt or ""),
        "user_msg_chars": len(user_msg or ""),
        "max_tokens": max_tokens,
        "timeout_seconds": timeout_seconds,
        "finish_reason": "",
        "usage": {},
        "output_chars": 0,
    }
    try:
        load_cfg = _refs.get("load_llm_config")
        if not load_cfg:
            meta["error_type"] = "config_missing"
            meta["error_message"] = "load_llm_config not available"
            return meta
        cfg = load_cfg()
        llm_url = cfg.get("llm_url", "")
        api_key = cfg.get("llm_api_key", "")
        model = cfg.get("llm_model", "")
        meta["model"] = model
        if not llm_url or not model:
            meta["error_type"] = "config_missing"
            meta["error_message"] = "llm_url or llm_model is empty"
            return meta

        build_fn = _refs.get("build_chat_completions_url")
        if build_fn:
            chat_url = build_fn(llm_url)
        else:
            chat_url = llm_url.rstrip("/")
            if not chat_url.endswith("/chat/completions"):
                chat_url += "/chat/completions"

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        resp = requests.post(chat_url, json=body, headers=headers, timeout=timeout_seconds)
        meta["status_code"] = resp.status_code
        if not resp.ok:
            meta["error_type"] = "http_error"
            meta["error_message"] = resp.text[:2000]
            return meta
        data = resp.json()
        choices = data.get("choices", [{}])
        first_choice = choices[0] if choices else {}
        content = first_choice.get("message", {}).get("content", "") if first_choice else ""
        meta["finish_reason"] = first_choice.get("finish_reason", "")
        meta["usage"] = data.get("usage", {}) or {}
        if not content:
            meta["error_type"] = "empty_response"
            meta["error_message"] = json.dumps(data, ensure_ascii=False)[:2000]
            return meta
        meta["ok"] = True
        meta["content"] = content.strip()
        meta["output_chars"] = len(meta["content"])
        return meta
    except requests.exceptions.Timeout as e:
        meta["error_type"] = "timeout"
        meta["error_message"] = str(e)
        return meta
    except requests.exceptions.RequestException as e:
        meta["error_type"] = type(e).__name__
        meta["error_message"] = str(e)
        return meta
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        meta["error_type"] = "api_response_parse_error"
        meta["error_message"] = str(e)
        return meta
    except Exception as e:
        meta["error_type"] = type(e).__name__
        meta["error_message"] = str(e)
        return meta


def _call_llm(
    system_prompt: str,
    user_msg: str,
    temperature: float = 0.3,
    max_tokens: int = 4096,
    timeout_seconds: int = LLM_REQ_TIMEOUT_NORMAL_SECONDS,
) -> Optional[str]:
    """Call LLM and return text content."""
    meta = _call_llm_detailed(system_prompt, user_msg, temperature, max_tokens, timeout_seconds)
    if not meta.get("ok"):
        _log(f"ppt_executor LLM call failed: {meta.get('error_type')}: {meta.get('error_message', '')[:300]}")
        return None
    return meta.get("content")


def _log(msg: str):
    """Log via app's log function if available."""
    fn = _refs.get("_log")
    if fn:
        fn(f"[ppt_executor] {msg}")
    else:
        print(f"[ppt_executor] {msg}")


def _write_log(action: str, details: dict, level: str = "info"):
    """Write structured executor logs via app.py when available."""
    fn = _refs.get("write_log")
    payload = {"component": "ppt_executor", **(details or {})}
    if fn:
        try:
            fn(action, payload, level=level)
            return
        except TypeError:
            fn(action, payload)
            return
        except Exception as exc:
            _log(f"structured log failed action={action}: {exc}")
    try:
        _log(f"[{action}] {json.dumps(payload, ensure_ascii=False)[:2000]}")
    except Exception:
        _log(f"[{action}] {payload}")


# ---------------------------------------------------------------------------
# SVG extraction from LLM responses
# ---------------------------------------------------------------------------

def _extract_svg(response: str) -> Optional[str]:
    """Extract SVG from LLM response. Handles markdown code blocks and raw SVG."""
    if not response:
        return None

    # Try markdown code block with svg/xml language tag
    match = re.search(r'```(?:svg|xml|html)\s*\n(.*?)```', response, re.DOTALL)
    if match:
        return match.group(1).strip()

    # Try any code block
    match = re.search(r'```\s*\n(.*?)```', response, re.DOTALL)
    if match:
        content = match.group(1).strip()
        if content.startswith('<svg'):
            return content

    # Try raw SVG
    match = re.search(r'(<svg[\s\S]*?</svg>)', response, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()

    return None


def _analyze_svg_response(response: str, finish_reason: str = "") -> Dict[str, Any]:
    """Return cheap diagnostics that explain why SVG extraction failed."""
    text = response or ""
    lower = text.lower()
    has_svg_open = bool(re.search(r'<svg\b', text, re.IGNORECASE))
    has_svg_close = "</svg>" in lower
    code_fence_count = text.count("```")
    return {
        "response_chars": len(text),
        "has_svg_open": has_svg_open,
        "has_svg_close": has_svg_close,
        "ends_with_svg_close": lower.rstrip().endswith("</svg>") or lower.rstrip().endswith("</svg>```"),
        "code_fence_count": code_fence_count,
        "has_unclosed_code_fence": code_fence_count % 2 == 1,
        "finish_reason": finish_reason or "",
        "likely_truncated": (
            finish_reason == "length"
            or (has_svg_open and not has_svg_close)
            or (has_svg_open and code_fence_count % 2 == 1)
        ),
        "tail_preview": text[-500:] if text else "",
    }


def _safe_file_stem(text: str, max_len: int = 40, fallback: str = "untitled") -> str:
    """Convert arbitrary page titles into one safe Windows filename segment."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text or "")
    cleaned = re.sub(r'[^\w\u4e00-\u9fa5\-]+', "_", cleaned, flags=re.UNICODE)
    cleaned = cleaned.strip(" ._")
    if not cleaned:
        cleaned = fallback
    return cleaned[:max_len].rstrip(" ._") or fallback


# ---------------------------------------------------------------------------
# ppt-master template helpers
# ---------------------------------------------------------------------------

def _load_template_json(relative_path: str, default=None):
    cache_key = f"json:{relative_path}"
    if cache_key in _template_index_cache:
        return _template_index_cache[cache_key]
    path = os.path.join(SKILL_DIR, relative_path)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        _template_index_cache[cache_key] = data
        return data
    except Exception as exc:
        _log(f"Failed to load template index {relative_path}: {exc}")
        return default


def _available_chart_templates() -> set:
    data = _load_template_json(os.path.join("templates", "charts", "charts_index.json"), {})
    charts = data.get("charts", {}) if isinstance(data, dict) else {}
    return set(charts.keys())


def _available_layout_packs() -> set:
    data = _load_template_json(os.path.join("templates", "layouts", "layouts_index.json"), {})
    return {k for k, v in (data or {}).items() if isinstance(v, dict)}


def _layout_pack_for_template(template: str) -> str:
    """Resolve an explicit application template id to a bundled layout pack."""
    template_id = str(template or "default").strip().lower()
    pack = _BUILTIN_TEMPLATE_LAYOUTS.get(template_id, "")
    return pack if pack in _available_layout_packs() else ""


def _load_template_design_tokens(template: str) -> Dict[str, Any]:
    """Load machine-readable identity tokens for an explicit built-in template."""
    pack = _layout_pack_for_template(template)
    if not pack:
        return {}
    data = _load_template_json(
        os.path.join("templates", "layouts", pack, "design_tokens.json"),
        {},
    )
    if not isinstance(data, dict) or not isinstance(data.get("colors"), dict):
        return {}
    # Cached JSON must not be mutated with per-request mode/style values.
    return json.loads(json.dumps(data, ensure_ascii=False))


def _load_template_asset_manifest(template: str) -> Dict[str, Any]:
    pack = _layout_pack_for_template(template)
    if not pack:
        return {}
    data = _load_template_json(
        os.path.join("templates", "layouts", pack, "asset_manifest.json"),
        {},
    )
    return data if isinstance(data, dict) else {}


def _chart_template_exists(template_name: str) -> bool:
    if not template_name:
        return False
    key = template_name[:-4] if template_name.endswith(".svg") else template_name
    if key not in _available_chart_templates():
        return False
    return os.path.exists(os.path.join(SKILL_DIR, "templates", "charts", f"{key}.svg"))


def _layout_template_exists(layout_ref: str) -> bool:
    if not layout_ref or "/" not in layout_ref:
        return False
    pack, basename = layout_ref.split("/", 1)
    basename = basename[:-4] if basename.endswith(".svg") else basename
    return os.path.exists(os.path.join(SKILL_DIR, "templates", "layouts", pack, f"{basename}.svg"))


def _select_layout_pack(intent: dict, visual_style: str = "", template: str = "default") -> str:
    """Pick one bundled layout pack as a conservative visual scaffold."""
    packs = _available_layout_packs()
    explicit_pack = _layout_pack_for_template(template)
    if explicit_pack:
        return explicit_pack
    text = " ".join(str(v) for v in [
        (intent or {}).get("topic", ""),
        (intent or {}).get("audience", ""),
        (intent or {}).get("scenario", ""),
        visual_style or "",
    ]).lower()

    candidates = []
    if any(s in text for s in ("government", "policy", "政务", "政府", "政策", "五年规划")):
        candidates.extend(["government_blue", "government_red"])
    if any(s in text for s in ("medical", "hospital", "health", "医学", "医疗", "医院")):
        candidates.append("medical_university")
    if any(s in text for s in ("education", "academic", "thesis", "research", "高校", "论文", "答辩", "研究")):
        candidates.append("academic_defense")
    if any(s in text for s in ("retro", "pixel", "game", "像素", "游戏")):
        candidates.append("pixel_retro")
    if any(s in text for s in ("心理", "psychology", "therapy", "counseling")):
        candidates.append("psychology_attachment")
    candidates.append("ai_ops")

    for candidate in candidates:
        if candidate in packs:
            return candidate
    return next(iter(sorted(packs)), "")


def _layout_basename_for_page(page: dict, page_num: int, total_pages: int) -> str:
    page_type = str((page or {}).get("type") or "").lower()
    title = str((page or {}).get("title") or "").lower()
    if page_num == 1 or page_type == "cover":
        return "01_cover"
    ending_titles = ("谢谢", "致谢", "thank you", "结束语")
    if page_type in ("ending", "closing", "summary_close") or any(marker in title for marker in ending_titles):
        return "04_ending"
    if page_type in ("toc", "agenda") or "目录" in title or "agenda" in title:
        return "02_toc"
    if page_type in ("chapter", "section"):
        return "02_chapter"
    return "03_content"


def _required_template_assets(layout_ref: str) -> List[str]:
    """Return image hrefs that must survive generation for branded layouts."""
    if not layout_ref.startswith("huawei_standard/"):
        return []
    basename = layout_ref.rsplit("/", 1)[-1].removesuffix(".svg")
    return {
        "01_cover": ["images/cover-explore.png", "images/brand-logo.png"],
        "02_toc": ["images/brand-logo-small.png"],
        "02_chapter": ["images/brand-logo-small.png"],
        "03_content": ["images/brand-logo-small.png"],
        "04_ending": ["images/cover-lighthouse.jpeg", "images/brand-logo.png"],
    }.get(basename, [])


def _missing_template_assets(svg_code: str, layout_ref: str) -> List[str]:
    image_hrefs = set(re.findall(
        r'<image\b[^>]*?(?:href|xlink:href)\s*=\s*["\']([^"\']+)["\']',
        svg_code or "",
        flags=re.IGNORECASE,
    ))
    return [asset for asset in _required_template_assets(layout_ref) if asset not in image_hrefs]


def _infer_chart_template(page: dict) -> str:
    explicit = str((page or {}).get("visualization") or "").strip()
    if explicit:
        mapped = _map_chart_to_template(explicit)
        if _chart_template_exists(mapped):
            return mapped

    page_type = str((page or {}).get("type") or "").strip()
    by_type = {
        "kpi_dashboard": "kpi_cards",
        "comparison_matrix": "comparison_table",
        "benchmark_matrix": "comparison_table",
        "timeline": "timeline",
        "process_flow": "process_flow",
        "architecture": "layered_architecture",
        "content_cards": "labeled_card",
        "decision_summary": "vertical_list",
        "hero_quote": "",
        "cover": "",
        "toc": "agenda_list",
    }
    candidate = by_type.get(page_type, "")
    return candidate if _chart_template_exists(candidate) else ""


def _infer_template_mappings(
    pages: List[Dict[str, Any]],
    intent: dict,
    visual_style: str = "",
    template: str = "default",
) -> Dict[str, Dict[str, str]]:
    layout_pack = _select_layout_pack(intent, visual_style, template)
    layouts = {}
    charts = {}
    total = len(pages or [])
    for idx, page in enumerate(pages or [], start=1):
        key = f"P{idx:02d}"
        if layout_pack:
            layout_ref = f"{layout_pack}/{_layout_basename_for_page(page, idx, total)}"
            if _layout_template_exists(layout_ref):
                layouts[key] = layout_ref
        chart_ref = _infer_chart_template(page)
        if chart_ref:
            charts[key] = chart_ref
    return {"layouts": layouts, "charts": charts}


def _stage_template_assets(template: str, svg_output: Path) -> List[str]:
    """Copy whitelisted built-in template images beside generated SVG files."""
    pack = _layout_pack_for_template(template)
    if not pack:
        return []
    source_dir = Path(SKILL_DIR) / "templates" / "layouts" / pack / "images"
    if not source_dir.is_dir():
        return []
    destination_dir = svg_output / "images"
    destination_dir.mkdir(parents=True, exist_ok=True)
    staged = []
    for source in source_dir.iterdir():
        if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        destination = destination_dir / source.name
        shutil.copy2(source, destination)
        staged.append(source.name)
    return sorted(staged)


def _read_text_file_limited(path: str, max_chars: int = PPT_TEMPLATE_CONTEXT_MAX_CHARS) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read(max_chars + 1)
        if len(text) > max_chars:
            return text[:max_chars] + "\n<!-- template truncated for prompt budget -->"
        return text
    except Exception as exc:
        return f"<!-- failed to read template: {exc} -->"


def _build_template_context(page_info: dict, simplified: bool = False) -> str:
    parts = []
    layout_ref = (page_info or {}).get("layout_template", "")
    chart_ref = (page_info or {}).get("chart_template", "")
    max_chars = PPT_TEMPLATE_CONTEXT_SIMPLIFIED_MAX_CHARS if simplified else PPT_TEMPLATE_CONTEXT_MAX_CHARS
    mode_note = (
        "Simplified retry mode: use this only as a compact structural hint. "
        "Do not copy decorative detail; keep the final SVG short and complete."
        if simplified else
        "Use this as the structural scaffold. Preserve the overall layout rhythm, "
        "spacing, header/footer logic, and visual proportions, but adapt content and colors to spec_lock."
    )

    if layout_ref and "/" in layout_ref:
        pack, basename = layout_ref.split("/", 1)
        basename = basename[:-4] if basename.endswith(".svg") else basename
        path = os.path.join(SKILL_DIR, "templates", "layouts", pack, f"{basename}.svg")
        if os.path.exists(path):
            required_assets = _required_template_assets(layout_ref)
            required_note = ""
            if required_assets:
                required_note = (
                    "\nMANDATORY BRAND ASSETS: retain these exact image href values in the generated SVG: "
                    + ", ".join(required_assets)
                    + ". Do not replace, omit, rename, or embed them as data URIs."
                )
            parts.append(
                "## Layout Template SVG\n"
                f"Reference: templates/layouts/{pack}/{basename}.svg\n"
                f"{mode_note}{required_note}\n"
                "```svg\n" + _read_text_file_limited(path, max_chars=max_chars) + "\n```"
            )

    if chart_ref:
        chart_key = chart_ref[:-4] if chart_ref.endswith(".svg") else chart_ref
        path = os.path.join(SKILL_DIR, "templates", "charts", f"{chart_key}.svg")
        if os.path.exists(path):
            parts.append(
                "## Chart / Diagram Template SVG\n"
                f"Reference: templates/charts/{chart_key}.svg\n"
                "Adapt this chart structure when the page needs a visualization. Preserve the visual type and "
                "chart-plot-area marker if present; replace labels/data with this page's content.\n"
                "```svg\n" + _read_text_file_limited(path, max_chars=max_chars) + "\n```"
            )

    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# System prompt builders
# ---------------------------------------------------------------------------

def _build_executor_system_prompt(mode: str = "pyramid", visual_style: str = "dark-tech") -> str:
    """Build the Executor system prompt with SVG rules + mode + visual style guidance."""
    mode_content = _get_mode_content(mode)
    style_content = _get_visual_style_content(visual_style)
    icon_catalog = _load_icon_catalog()

    return f"""\
You are a professional SVG designer generating PPT-ready SVG slides. Your output will be
exported to PowerPoint via python-pptx. Follow ALL rules below strictly.

## Narrative Mode — how to organize arguments across pages
{mode_content}

## Visual Style — how each page looks
{style_content}

## Core SVG Rules (MANDATORY)

### Character Rules
- Use RAW Unicode characters for typography: — (em dash), — (en dash), ©, ®, →, ·, NBSP
- NEVER use HTML named entities: &mdash; &ndash; &copy; &reg; &rarr; &nbsp; &hellip;
- XML reserved chars MUST be escaped: &amp; &lt; &gt; &quot; &apos;
  Example: "R&amp;D", "error &lt; 5%"

### FORBIDDEN Features (will break PPTX export)
- rgba() — use fill="#HEX" fill-opacity="0.x" instead
- <g opacity="..."> — set opacity on EACH child element individually
- <style>, class, <foreignObject>, textPath, @font-face
- <animate*>, <script>, <iframe>, mask, <symbol>+<use>
- HTML named entities in text (see above)

### CONDITIONALLY ALLOWED
- clipPath: ONLY on <image> elements, with single <circle>/<ellipse>/<rect rx>/<path>/<polygon> child
- marker-start/marker-end: ONLY with orient="auto", shapes: triangle/diamond/oval

### FORBIDDEN for backgrounds and grids
- <pattern> — PPTX export CANNOT handle grid/pattern fills correctly.
  Instead, draw individual <line> elements for grid lines:
    <!-- GOOD: grid lines -->
    <line x1="0" y1="0" x2="0" y2="720" stroke="#334155" stroke-width="0.5" stroke-opacity="0.3"/>
    <line x1="80" y1="0" x2="80" y2="720" stroke="#334155" stroke-width="0.5" stroke-opacity="0.3"/>
  Or use <path> with multiple M/L commands for efficiency:
    <path d="M0 0V720 M80 0V720 M160 0V720 M0 0H1280 M0 80H1280" stroke="#334155" stroke-width="0.5" stroke-opacity="0.3" fill="none"/>

### SVG Structure
- viewBox MUST match the canvas from spec_lock.md (default: "0 0 1280 720")
- Background MUST be a <rect> covering the full viewBox
- Use <tspan> for multi-line text within a single <text> element
- Font stacks MUST end with a pre-installed font:
  "Microsoft YaHei", "PingFang SC", Arial, sans-serif / SimSun, serif / Consolas, "Courier New", monospace

### Icons
- **Primary method**: Use ppt-master icon placeholders for ALL icons.
  `<use data-icon="LIBRARY/icon-name" x="..." y="..." width="..." height="..." fill="#HEX"/>`
- This data-icon placeholder is the ONLY allowed `<use>` form. `finalize_svg.py` embeds real SVG shapes before PPTX export.
- **CRITICAL**: The icon library (e.g. `tabler-filled`, `tabler-outline`) is specified in spec_lock.md `## icons > library`. Use ONLY that library.
- ALL icon names in `<use data-icon="...">` MUST come from spec_lock.md `## icons > inventory`.
- If a needed concept is not in the inventory, use the closest available name from the inventory — do NOT invent new names.
- **Fallback only if no suitable icon exists in inventory**: draw simple inline SVG shapes (<circle>, <rect>, <path>).
- NEVER use ordinary href-based `<use>`, `<symbol>`, or `<image>` for icons.
- See the icon catalog below for available icon names (cross-reference with spec_lock.md inventory).

{icon_catalog}

### Image Handling
- For image transparency overlay: use stacked <rect> with gradients, NOT rgba()
- <image> tags reference files in images/ directory

### Grouping
- Wrap logical sections in <g id="..."> with descriptive ids
- 3-8 top-level content groups per page

### Colors & Consistency
- ALL colors from spec_lock.md colors section — do NOT invent new HEX values
- Use the exact color names (primary, accent, text, border, etc.) as listed
- Gradient definitions in <defs> at the top of the SVG

## Output Format

Output ONLY the SVG code in a markdown code block. No explanations, no commentary:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="...">
  ...
</svg>
```"""


def _build_page_prompt(
    page_index: int,
    total_pages: int,
    page_info: dict,
    spec_lock_lines: str,
    design_spec_context: str,
    template_context: str = "",
    simplified: bool = False,
) -> str:
    """Build prompt for a single page's SVG generation."""
    page_num = f"P{page_index:02d}"
    rhythm = page_info.get("rhythm", "dense")
    layout = page_info.get("layout", "Free design")
    title = page_info.get("title", "")
    visualization = page_info.get("visualization", "")
    content_points = page_info.get("content", [])

    content_text = "\n".join(f"  - {pt}" for pt in content_points) if content_points else "  (见设计规格)"

    visualization_line = f"\n- **Visualization**: {visualization}" if visualization else ""
    layout_template = page_info.get("layout_template", "")
    chart_template = page_info.get("chart_template", "")
    template_line = ""
    if layout_template or chart_template:
        template_line = (
            f"\n- **Layout template**: {layout_template or 'none'}"
            f"\n- **Chart template**: {chart_template or 'none'}"
        )
    rhythm_guide = {
        "anchor": "Structural page (cover/chapter/ending) — follow template style, centered, bold",
        "dense": "Information-heavy — use cards, multi-column, tables, or charts",
        "breathing": "Low-density — single concept, hero quote, big image+text, NO card grids",
    }.get(rhythm, "Information-heavy — standard layout")

    simplified_rules = ""
    if simplified:
        simplified_rules = """

## Simplified Retry Mode (MANDATORY)
The previous attempt was too long, truncated, timed out, or failed SVG extraction.
Generate a shorter complete SVG:
- Target under 12,000 characters.
- Keep only essential content: title, 3-5 key text items, and one compact visual structure.
- Prefer template skeletons, simple rect/line/circle/path elements, and <use data-icon="..."> placeholders.
- Avoid decorative grids, repeated tiny shapes, complex paths, large gradients, shadows, and verbose comments.
- If chart data is dense, show the top 4-6 items only and summarize the rest in one note.
- The SVG must be complete and end with </svg>; completeness beats detail.
"""

    return f"""\
Generate SVG for page {page_index} of {total_pages}.

## Page Context
- **Number**: {page_num}  |  **Rhythm**: {rhythm} ({rhythm_guide})
- **Layout**: {layout}{visualization_line}{template_line}
- **Title**: {title}

## Content Points
{content_text}

## Design Contract (spec_lock.md) — re-read before generating
{spec_lock_lines}

## Design Narrative (from design_spec.md)
{design_spec_context}

## Template Guidance (ppt-master)
{template_context or "(No template matched. Use free design while obeying spec_lock.)"}
{simplified_rules}

Generate the SVG now. Follow ALL rules from the system prompt. Output ONLY the SVG code block."""


# ---------------------------------------------------------------------------
# Spec file generation
# ---------------------------------------------------------------------------

def _generate_spec_files(
    final_outline: str,
    intent: dict,
    template: str = "default",
    reference_style: Dict[str, Any] = None,
) -> Dict[str, str]:
    """
    Convert backend final_outline + intent into design_spec.md + spec_lock.md.

    If reference_style is provided (from a reference PPTX), uses extracted colors/fonts
    instead of LLM generation.

    Returns {"design_spec": "...", "spec_lock": "...", "project_name": "...", "page_count": N}.
    """
    topic = (intent or {}).get("topic", "") or "未命名"
    audience = (intent or {}).get("audience", "") or "通用受众"
    scenario = (intent or {}).get("scenario", "") or "技术汇报"

    page_blocks = re.findall(r'^#\s+第?\d+\s*页', final_outline, re.MULTILINE)
    page_count = len(page_blocks) or 8
    project_name = re.sub(r'[^\w\u4e00-\u9fa5\-]', '_', topic)[:40]

    rhythms = _extract_rhythms_from_outline(final_outline)
    charts = _extract_charts_from_outline(final_outline)
    pages_for_templates = _parse_pages_from_outline(final_outline)

    # The explicitly selected built-in template owns its visual identity. A
    # reference PPTX may refine the default template, but must not silently
    # replace branded tokens or erase mode/style fields.
    reference_extracted = bool(
        reference_style
        and reference_style.get("extracted", reference_style.get("slide_count", 0) > 0)
        and reference_style.get("colors")
    )
    if not _layout_pack_for_template(template) and reference_extracted:
        visual_design = {
            **reference_style,
            "mode": (intent or {}).get("mode") or _select_mode(intent),
            "visual_style": (
                (intent or {}).get("visual_style")
                or _select_visual_style(intent, reference_style.get("theme", "dark"))
            ),
        }
    else:
        visual_design = _generate_visual_design(final_outline, intent, template)

    template_mappings = _infer_template_mappings(
        pages_for_templates,
        intent,
        visual_design.get("visual_style", "dark-tech"),
        template,
    )
    inferred_charts = template_mappings.get("charts", {})
    if charts:
        inferred_charts.update({
            key: _map_chart_to_template(value)
            for key, value in charts.items()
            if _chart_template_exists(_map_chart_to_template(value))
        })

    spec_lock_lines = _build_spec_lock(
        project_name,
        page_count,
        rhythms,
        inferred_charts,
        visual_design,
        layouts=template_mappings.get("layouts", {}),
    )
    design_spec = _build_design_spec(project_name, page_count, final_outline, intent, template, visual_design)

    return {
        "design_spec": design_spec,
        "spec_lock": spec_lock_lines,
        "project_name": project_name,
        "page_count": page_count,
        "visual_design": visual_design,
        "mode": visual_design.get("mode", "briefing"),
        "visual_style": visual_design.get("visual_style", "dark-tech"),
        "template_mappings": {
            "layouts": template_mappings.get("layouts", {}),
            "charts": inferred_charts,
        },
    }


def _generate_visual_design(final_outline: str, intent: dict, template: str = "default") -> Dict[str, Any]:
    """
    Use LLM to generate color scheme, font recommendation, and icon inventory.
    Also selects mode and visual_style based on content signals.
    """
    topic = (intent or {}).get("topic", "")

    # Auto-select mode and visual style (respect user override from intent)
    selected_mode = (intent or {}).get("mode") or _select_mode(intent)
    selected_style = (intent or {}).get("visual_style") or _select_visual_style(intent, "dark")

    template_design = _load_template_design_tokens(template)
    if template_design:
        template_design["mode"] = selected_mode
        template_design["visual_style"] = template_design.get("visual_style") or selected_style
        template_design["template_assets"] = _load_template_asset_manifest(template)
        return template_design

    # Extract content keywords for context
    content_preview = final_outline[:2000]

    system_prompt = """\
You are a presentation design specialist. Based on the topic, content preview, and visual style,
recommend a complete visual design system. Output ONLY valid JSON with these keys:

{
  "theme": "dark" or "light",
  "colors": {
    "bg": "#HEX",
    "secondary_bg": "#HEX",
    "primary": "#HEX",
    "accent": "#HEX",
    "secondary_accent": "#HEX",
    "text": "#HEX",
    "text_secondary": "#HEX",
    "border": "#HEX",
    "success": "#HEX",
    "warning": "#HEX"
  },
  "typography": {
    "font_stack": "full CSS font-family string for body",
    "title_stack": "full CSS font-family string for titles",
    "body_size": 18 or 20 or 22 or 24,
    "title_size": 28-36
  },
  "icons": ["icon1", "icon2", ...10-20 icons],
  "design_rationale": "one sentence in Chinese"
}

Visual style — this affects theme and color palette:
- swiss-minimal: Swiss-grid discipline. Prefers LIGHT theme (white/near-white bg, dark text).
- soft-rounded: Warm, approachable. Prefers LIGHT theme.
- editorial: Magazine / print style. Prefers LIGHT theme with serif.
- sketch-notes: Warm hand-drawn. Prefers LIGHT theme (soft warm paper field).
- ink-notes: Whiteboard minimal. Prefers LIGHT theme (pale field).
- ink-wash: Rice-paper ink-wash. Prefers LIGHT theme (pale rice-paper field).
- chalkboard: Classroom chalkboard. Prefers DARK theme (dark slate field, chalk accents).
- glassmorphism: Frosted glass. Prefers DARK theme (dark field, luminous glass panels).
- blueprint: Engineering schematic. Prefers DARK theme (dark paper field, line work).
- dark-tech: Tech / AI / dark theme. Prefers DARK theme (dark bg, light text).

Color rules:
- Visual style "{selected_style}" → use theme as implied above
- Dark theme: bg dark (#0B-1A range), text light (#D0-FF range), primary vivid
- Light theme: bg white/light, text dark, primary rich
- accent = vivid complementary to primary for data highlights
- 60-30-10 rule implied: bg 60%, primary/secondary_bg 30%, accent 10%

Font rules: MUST end with pre-installed Windows fonts (Microsoft YaHei/Arial/sans-serif or SimSun/Georgia/serif).

Icon rules: pick 10-15 icons most relevant to the content from this list:
%s
Use the exact kebab-case names as shown. Do not invent new names.""".replace('%s', ', '.join(_COMMON_PRESENTATION_ICONS))

    user_prompt = f"""\
Topic: {topic}
Visual style: {selected_style}
Content preview (first 2000 chars):
{content_preview}

Generate the visual design JSON now. Respond with ONLY the JSON, no markdown, no explanation."""

    response = _call_llm(
        system_prompt=system_prompt,
        user_msg=user_prompt,
        temperature=0.4,
        max_tokens=2048,
        timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS,
    )

    if response:
        try:
            json_match = re.search(r'\{[\s\S]*\}', response or "")
            if json_match:
                result = json.loads(json_match.group())
                result["mode"] = selected_mode
                result["visual_style"] = selected_style
                return result
        except (json.JSONDecodeError, ValueError):
            pass

    # Fallback: respect visual_style for theme and colors
    light_style = selected_style in ("swiss-minimal", "soft-rounded", "editorial", "sketch-notes", "ink-notes", "ink-wash")
    if light_style:
        fallback = {
            "theme": "light",
            "colors": {
                "bg": "#FFFFFF", "secondary_bg": "#F8F9FB",
                "primary": "#2563EB", "accent": "#059669", "secondary_accent": "#7C3AED",
                "text": "#1E293B", "text_secondary": "#64748B", "border": "#E2E8F0",
                "success": "#16A34A", "warning": "#D97706",
            },
            "typography": {
                "font_stack": '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
                "title_stack": 'Georgia, "Microsoft YaHei", serif',
                "body_size": 18, "title_size": 32,
            },
            "icons": ["bulb", "chart-bar", "award", "code", "server", "apps", "shield", "rocket",
                       "target", "list", "star", "check", "bolt", "settings", "database", "graph",
                       "globe", "user", "link", "search"],
            "design_rationale": "浅色主题，干净专业，适合信息展示" if selected_style == "swiss-minimal"
                else "暖色浅色主题，亲和友好" if selected_style == "soft-rounded"
                else "印刷风格浅色主题",
        }
    else:
        fallback = {
            "theme": "dark",
            "colors": {
                "bg": "#0B1120", "secondary_bg": "#131E33",
                "primary": "#3B82F6", "accent": "#06B6D4", "secondary_accent": "#8B5CF6",
                "text": "#E2E8F0", "text_secondary": "#94A3B8", "border": "#1E3A5F",
                "success": "#10B981", "warning": "#EF4444",
            },
            "typography": {
                "font_stack": '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
                "title_stack": 'Georgia, "Microsoft YaHei", serif',
                "body_size": 18, "title_size": 32,
            },
            "icons": ["bulb", "chart-bar", "award", "code", "server", "apps", "shield", "rocket",
                       "target", "list", "star", "check", "bolt", "settings", "database", "graph",
                       "globe", "user", "link", "search"],
            "design_rationale": "深色科技主题，适合数据密集型技术汇报",
        }
    fallback["mode"] = selected_mode
    fallback["visual_style"] = selected_style
    return fallback


def _build_spec_lock(
    project_name: str,
    page_count: int,
    rhythms: Dict[str, str] = None,
    charts: Dict[str, str] = None,
    visual_design: Dict[str, Any] = None,
    layouts: Dict[str, str] = None,
) -> str:
    """Build spec_lock.md with LLM-generated color/font/icon and dynamic rhythm/chart."""
    v = visual_design or {}
    c = v.get("colors", {})
    t = v.get("typography", {})

    # Colors from LLM or fallback
    colors = "\n".join(
        f'- {k}: {json.dumps(v)}' if not isinstance(v, str) else f'- {k}: {v}'
        for k, v in {
            "bg": c.get("bg", "#0B1120"),
            "secondary_bg": c.get("secondary_bg", "#131E33"),
            "primary": c.get("primary", "#3B82F6"),
            "accent": c.get("accent", "#06B6D4"),
            "secondary_accent": c.get("secondary_accent", "#8B5CF6"),
            "text": c.get("text", "#E2E8F0"),
            "text_secondary": c.get("text_secondary", "#94A3B8"),
            "border": c.get("border", "#1E3A5F"),
            "success": c.get("success", "#10B981"),
            "warning": c.get("warning", "#EF4444"),
        }.items()
    )
    chart_palette = v.get("chart_palette") or []
    if chart_palette:
        colors += f'\n- chart_palette: {json.dumps(chart_palette, ensure_ascii=False)}'

    # Typography
    body_size = t.get("body_size", 18)
    font_stack = t.get("font_stack", '"Microsoft YaHei", "PingFang SC", Arial, sans-serif')
    title_stack = t.get("title_stack", 'Georgia, "Microsoft YaHei", serif')

    # Icons — determine library from visual_style, scan filesystem for real names
    icon_library = _get_icon_library(v.get("visual_style", "dark-tech"))
    all_icons_in_library = _scan_library_flat(icon_library)

    # Filter curated common icons against chosen library (guarantees quality floor)
    common_verified = [n for n in _COMMON_PRESENTATION_ICONS if n in all_icons_in_library]

    # Also include any LLM suggestions that match the library
    suggested = v.get("icons", [])
    suggested_verified = [n for n in suggested if n in all_icons_in_library]

    # Combine: curated first, then LLM extras (deduplicated, order preserved)
    verified = list(dict.fromkeys(common_verified + suggested_verified))
    icons_str = ", ".join(verified[:30])
    if layouts:
        layout_lines = [f"- {key}: {layouts[key]}" for key in sorted(layouts.keys())]
    else:
        layout_lines = ["# (free design - no template)"]

    # Page rhythm — use extracted rhythms or fallback
    if rhythms:
        rhythm_lines = [f"- {key}: {rhythms.get(key, 'dense')}"
                        for key in sorted(rhythms.keys())]
    else:
        rhythm_lines = [f"- P{i+1:02d}: anchor" if i == 0 or i == page_count - 1
                        else f"- P{i+1:02d}: dense"
                        for i in range(page_count)]

    # Page charts — use extracted charts or none
    if charts:
        chart_lines = [f"- {key}: {_map_chart_to_template(charts[key])}"
                       for key in sorted(charts.keys())]
    else:
        chart_lines = ["# (none)"]

    asset_manifest = v.get("template_assets") or {}
    asset_entries = asset_manifest.get("assets", {}) if isinstance(asset_manifest, dict) else {}
    image_lines = (
        [f'- images/{name}: {description}' for name, description in asset_entries.items()]
        if isinstance(asset_entries, dict) and asset_entries else
        ["# (none)"]
    )

    # Mode and visual style
    mode_name = v.get("mode", "briefing")
    style_name = v.get("visual_style", "dark-tech")
    if mode_name not in _MODE_PRESETS:
        mode_name = "briefing"
    if style_name not in _VISUAL_STYLE_PRESETS:
        style_name = "dark-tech"

    return f"""# Execution Lock

## canvas
- viewBox: 0 0 1280 720
- format: PPT 16:9

## mode
- mode: {mode_name}

## visual_style
- visual_style: {style_name}

## colors
{colors}

## typography
- font_family: {font_stack}
- title_family: {title_stack}
- body_family: {font_stack}
- code_family: Consolas, "Courier New", monospace
- body: {body_size}
- title: {t.get("title_size", 32)}
- subtitle: {t.get("subtitle_size", max(20, body_size + 2))}
- annotation: {max(12, body_size - 4)}

## icons
- library: {icon_library}
- inventory: {icons_str}

## images
{chr(10).join(image_lines)}

## page_rhythm
{chr(10).join(rhythm_lines)}

## page_layouts
{chr(10).join(layout_lines)}

## page_charts
{chr(10).join(chart_lines)}

## forbidden
- Mixing icon libraries
- rgba()
- <style>, class, <foreignObject>, textPath, @font-face, <animate*>, <script>, <iframe>, <symbol>+<use>
- <g opacity> (set opacity on each child element individually)
- HTML named entities in text (&nbsp;, &mdash;, &copy;, &reg;, &hellip;, &bull; …) — write as raw Unicode
"""


def _build_design_spec(
    project_name: str,
    page_count: int,
    final_outline: str,
    intent: dict,
    template: str = "default",
    visual_design: Dict[str, Any] = None,
) -> str:
    """Build design_spec.md with LLM-generated visual design and full narrative."""
    topic = (intent or {}).get("topic", project_name)
    audience = (intent or {}).get("audience", "通用受众")
    scenario = (intent or {}).get("scenario", "技术汇报")
    date_str = datetime.now().strftime("%Y-%m-%d")
    v = visual_design or {}

    # Extract page outlines for §IX
    pages = _parse_pages_from_outline(final_outline)
    outline_section = _build_outline_section(pages)

    c = v.get("colors", {})
    t = v.get("typography", {})
    body_size = t.get("body_size", 18)
    theme = v.get("theme", "dark")
    rationale = v.get("design_rationale", "深色科技主题")
    primary_color = c.get("primary", "#3B82F6")
    accent_color = c.get("accent", "#06B6D4")
    style_name = v.get("visual_style", "dark-tech")
    no_gradients = style_name in ("swiss-minimal", "editorial", "sketch-notes", "ink-notes", "chalkboard", "ink-wash", "blueprint", "huawei-corporate")
    px_str = "px"  # avoid Python 3.13 f-string parser misreading "NNNpx" as number literal
    b = "**"       # avoid Python 3.13 f-string parser misreading "**" as operator

    gradient_section = "" if no_gradients else f"""

### Gradient Scheme

```xml
<linearGradient id="primaryGrad" x1="0%" y1="0%" x2="100%" y2="100%">
  <stop offset="0%" stop-color="{primary_color}"/>
  <stop offset="100%" stop-color="{accent_color}"/>
</linearGradient>
<radialGradient id="bgGlow" cx="80%" cy="20%" r="60%">
  <stop offset="0%" stop-color="{primary_color}" stop-opacity="0.08"/>
  <stop offset="100%" stop-color="{primary_color}" stop-opacity="0"/>
</radialGradient>
```"""

    asset_manifest = v.get("template_assets") or {}
    asset_entries = asset_manifest.get("assets", {}) if isinstance(asset_manifest, dict) else {}
    if isinstance(asset_entries, dict) and asset_entries:
        image_resource_section = "\n".join(
            f"- `images/{name}`: {description}" for name, description in asset_entries.items()
        )
        image_resource_section += (
            "\n\nUse only these whitelisted relative paths. Keep titles, dates, sources, "
            "page numbers, and body copy as editable SVG text."
        )
    else:
        image_resource_section = "No external images; all content is text, charts, and icons."

    # Parse font stacks for the summary table
    title_stack_raw = t.get("title_stack", 'Georgia, "Microsoft YaHei", serif')
    body_stack_raw = t.get("font_stack", '"Microsoft YaHei", "PingFang SC", Arial, sans-serif')
    def _parse_font_stack(stack):
        parts = [p.strip().strip('"') for p in stack.split(",")]
        cn = [p for p in parts if any('\u4e00' <= c <= '\u9fff' for c in p) or p in ("Microsoft YaHei", "PingFang SC", "SimSun", "Noto Sans SC", "Hiragino Sans GB")]
        en = [p for p in parts if p not in cn and p not in ("sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui")]
        tail = [p for p in parts if p in ("sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui")]
        return cn, en, tail
    __title_cn, __title_en, __title_tail = _parse_font_stack(title_stack_raw)
    __body_cn, __body_en, __body_tail = _parse_font_stack(body_stack_raw)
    __title_cn_str = ', '.join(__title_cn) if __title_cn else '-'
    __title_en_str = ', '.join(__title_en) if __title_en else '-'
    __title_tail_str = ', '.join(__title_tail) if __title_tail else '-'
    __body_cn_str = ', '.join(__body_cn) if __body_cn else '-'
    __body_en_str = ', '.join(__body_en) if __body_en else '-'
    __body_tail_str = ', '.join(__body_tail) if __body_tail else '-'

    return f"""# {project_name} - Design Spec

> {topic}

## I. Project Information

| Item | Value |
| ---- | ----- |
| {b}Project Name{b} | {project_name} |
| {b}Canvas Format{b} | PPT 16:9 (1280\u00d7720) |
| {b}Page Count{b} | {page_count} |
| {b}Design Style{b} | {rationale} |
| {b}Target Audience{b} | {audience} |
| {b}Use Case{b} | {scenario} |
| {b}Created Date{b} | {date_str} |

---

## II. Canvas Specification

| Property | Value |
| -------- | ----- |
| {b}Format{b} | PPT 16:9 |
| {b}Dimensions{b} | 1280\u00d7720 |
| {b}viewBox{b} | `0 0 1280 720` |
| {b}Margins{b} | left/right 60px, top/bottom 50px |
| {b}Content Area{b} | 1160×620 |

---

## III. Visual Theme

- {b}Style{b}: {rationale}
- {b}Theme{b}: {"Dark" if theme == "dark" else "Light"} theme
- {b}Tone{b}: tech, professional, data-driven

### Color Scheme

| Role | HEX | Purpose |
| ---- | --- | ------- |
| {b}Background{b} | `{c.get("bg", "#0B1120")}` | Page background |
| {b}Secondary bg{b} | `{c.get("secondary_bg", "#131E33")}` | Card / section background |
| {b}Primary{b} | `{primary_color}` | Titles, key sections, icons |
| {b}Accent{b} | `{accent_color}` | Data highlights, key info |
| {b}Secondary accent{b} | `{c.get("secondary_accent", "#8B5CF6")}` | Secondary emphasis |
| {b}Body text{b} | `{c.get("text", "#E2E8F0")}` | Main body text |
| {b}Secondary text{b} | `{c.get("text_secondary", "#94A3B8")}` | Captions, annotations |
| {b}Border{b} | `{c.get("border", "#1E3A5F")}` | Card borders, dividers |
{gradient_section}

{b}Typography direction{b}: {rationale}

| Role | Chinese | English | Fallback tail |
| ---- | ------- | ------- | ------------- |
| {b}Title{b} | `{__title_cn_str}` | `{__title_en_str}` | `{__title_tail_str}` |
| {b}Body{b} | `{__body_cn_str}` | `{__body_en_str}` | `{__body_tail_str}` |

{b}Per-role font stacks{b}:
- Title: {title_stack_raw}
- Body: {body_stack_raw}
- Code: `Consolas, "Courier New", monospace`

{b}Baseline{b}: Body = {body_size}px

| Purpose | Ratio to body | Size @ body={body_size} | Weight |
| ------- | ------------- | ------------- | ------ |
| Cover title | {"3x"} | {body_size * 3}px | Bold |
| Page title | {"1.75x"} | {int(body_size * 1.75)}px | Bold |
| Subtitle | {"1.3x"} | {int(body_size * 1.3)}px | SemiBold |
| {b}Body{b} | {b}{"1x"}{b} | {b}{body_size}px{b} | Regular |
| Annotation | {"0.78x"} | {int(body_size * 0.78)}px | Regular |

---

## V. Layout Principles

Available patterns (10+): 
full_bleed (hero/cover), split_left_right (comparison), three_column_cards (features),
top_bottom (timeline/process), center_radiating (architecture), z_pattern (storytelling),
negative_space (breathing), kpi_grid (dashboard), comparison_table (benchmark), hero_quote (testimonial).

Spacing: safe margin 60{px_str}, card gap 24{px_str}, card padding 24{px_str}, card border radius 12{px_str}.

---

## VI. Icon Usage Specification

- {b}Library{b}: {_get_icon_library(style_name)}
- {b}Method{b}: `<use data-icon="{_get_icon_library(style_name)}/icon-name" .../>`

---

## VII. Visualization Reference List

See spec_lock.md page_charts for exact chart-template mappings.

---

## VIII. Image Resource List

{image_resource_section}

---

## IX. Content Outline

{outline_section}

---

## X. Speaker Notes Requirements

One note per page in conversational Chinese, matching the page's core message.
"""


def _build_outline_section(pages: List[Dict[str, Any]]) -> str:
    """Build the §IX Content Outline from parsed pages."""
    lines = []
    for i, page in enumerate(pages):
        page_num = i + 1
        title = page.get("title", f"第{page_num}页")
        layout = page.get("layout", "Card grid")
        rhythm = page.get("rhythm", "")
        points = page.get("content", [])
        chart = page.get("visualization", "")
        summary = page.get("summary", "")

        layout_line = f"- **Layout**: {layout}"
        rhythm_hint = f" (rhythm: {rhythm})" if rhythm else ""
        chart_line = f"\n- **Visualization**: {chart}" if chart else ""
        content_block = "\n".join(f"  - {pt}" for pt in points) if points else ""
        summary_line = f"\n- **Summary**: {summary}" if summary else ""

        lines.append(
            f"#### Slide {page_num:02d} - {title}\n\n"
            f"{layout_line}{rhythm_hint}{chart_line}\n"
            f"- **Content**:\n{content_block}"
            f"{summary_line}\n"
        )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Page parsing from design_spec / final_outline
# ---------------------------------------------------------------------------

def _parse_pages_from_outline(final_outline: str) -> List[Dict[str, Any]]:
    """
    Parse the final_outline (Markdown with # 第N页 headers) into a list of page dicts.
    Supports [TYPE], [RHYTHM], [LAYOUT], [CHART], [UNIT], [summary], [SOURCE], [VERIFY].
    """
    pages = []

    blocks = _split_outline_page_blocks(final_outline)

    for block in blocks:
        if not block.strip():
            continue

        title_match = re.match(r'#\s+第?\d+\s*[页：:\-]\s*(.+)', block)
        title = title_match.group(1).strip() if title_match else ""

        type_match = re.search(r'\[TYPE\]:\s*(\S+)', block)
        page_type = type_match.group(1) if type_match else "content_cards"

        rhythm_match = re.search(r'\[RHYTHM\]:\s*(\S+)', block)
        rhythm = rhythm_match.group(1) if rhythm_match else ""

        layout_match = re.search(r'\[LAYOUT\]:\s*(\S+)', block)
        layout = layout_match.group(1) if layout_match else ""

        chart_match = re.search(r'\[CHART\]:\s*(\S+)', block)
        visualization = chart_match.group(1) if chart_match else ""

        content_lines = []
        summary = ""
        for line in block.split('\n'):
            stripped = line.strip()
            if re.match(r'^[-*]\s+', stripped):
                content_lines.append(re.sub(r'^[-*]\s+', '', stripped))
            elif stripped.startswith('[summary]'):
                summary = stripped.replace('[summary]', '').strip()
                break

        # Resolve layout from LAYOUT marker, fallback to type-based mapping
        resolved_layout = layout or _map_type_to_layout(page_type)

        pages.append({
            "title": title or f"第{len(pages)+1}页",
            "type": page_type,
            "rhythm": rhythm,
            "layout": resolved_layout,
            "visualization": visualization,
            "content": content_lines if content_lines else [summary or title],
            "summary": summary,
        })

    return pages


def _extract_rhythms_from_outline(final_outline: str) -> Dict[str, str]:
    """Extract per-page [RHYTHM] markers. Returns {P01: anchor, P02: dense, ...}."""
    rhythms = {}
    blocks = _split_outline_page_blocks(final_outline)
    for i, block in enumerate(blocks):
        if not block.strip():
            continue
        match = re.search(r'\[RHYTHM\]:\s*(\S+)', block)
        if match:
            rhythms[f"P{(i+1):02d}"] = match.group(1)
    return rhythms


def _extract_charts_from_outline(final_outline: str) -> Dict[str, str]:
    """Extract per-page [CHART] markers. Returns {P03: kpi_cards, P07: comparison_table, ...}."""
    charts = {}
    blocks = _split_outline_page_blocks(final_outline)
    for i, block in enumerate(blocks):
        if not block.strip():
            continue
        match = re.search(r'\[CHART\]:\s*(\S+)', block)
        if match:
            charts[f"P{(i+1):02d}"] = match.group(1)
    return charts


def _map_type_to_layout(page_type: str) -> str:
    """Map ppt_pipeline [TYPE] to design_spec layout description with rhythm bias."""
    mapping = {
        "kpi_dashboard": "KPI grid (2×2 or 1×4 metric cards)",
        "comparison_matrix": "Comparison table / split matrix",
        "benchmark_matrix": "Benchmark comparison matrix",
        "timeline": "Horizontal timeline with milestones",
        "process_flow": "Step flow / chevron waterfall",
        "architecture": "Architecture diagram / center-radiating",
        "content_cards": "Card grid (2-4 column cards)",
        "decision_summary": "Summary with key takeaways + risk callouts",
        "hero_quote": "Large quote + speaker attribution (breathing)",
        "cover": "Full-bleed background + centered hero title",
        "toc": "Multi-column chapter cards",
    }
    return mapping.get(page_type, "Card grid (2-4 column cards)")


def _split_outline_page_blocks(final_outline: str) -> List[str]:
    """Split an outline into page blocks using markdown separators or headings."""
    text = final_outline or ""
    blocks = [b.strip() for b in re.split(r'\n\s*---\s*\n', text) if b.strip()]
    if len(blocks) > 1:
        return blocks

    matches = list(re.finditer(r'(?m)^#\s+.+$', text))
    if not matches:
        return [text.strip()] if text.strip() else []
    result = []
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        if block:
            result.append(block)
    return result


def _map_chart_to_template(chart_name: str) -> str:
    """Map backend [CHART] marker to ppt-master chart template name.

    Supports both short legacy names and full template names from charts_index.json.
    Unknown names pass through directly (the caller validates existence).
    """
    mapping = {
        # Legacy short names
        "grouped_bar": "grouped_bar_chart",
        "stacked_bar": "stacked_bar_chart",
        "benchmark_table": "comparison_table",
        "slope": "slope_chart",
        "kpi_bar": "kpi_cards",
        "pie": "pie_chart",
        "radar": "radar_chart",
        "timeline_horizontal": "timeline_horizontal",
        "process_flow": "chevron_process",
        "waterfall": "waterfall_chart",
        # Additional common short names
        "bar": "bar_chart",
        "line": "line_chart",
        "donut": "donut_chart",
        "funnel": "funnel_chart",
        "gauge": "gauge_chart",
        "gantt": "gantt_chart",
        "heatmap": "heatmap_chart",
        "scatter": "scatter_chart",
        "bubble": "bubble_chart",
        "sankey": "sankey_chart",
        "venn": "venn_diagram",
        "swot": "quadrant_text_bullets",
        "org_chart": "top_down_tree",
        "fishbone": "fishbone_diagram",
        "roadmap": "roadmap_vertical",
        "mindmap": "mind_map",
        "wordcloud": "word_cloud",
    }
    return mapping.get(chart_name, chart_name)


# ---------------------------------------------------------------------------
# Core: Executor Phase (SVG generation page by page)
# ---------------------------------------------------------------------------

def executor_phase(
    project_path: str,
    spec_lock_content: str,
    design_spec_content: str,
    final_outline: str,
    intent: Optional[Dict[str, Any]] = None,
    template: str = "default",
    mode: str = "pyramid",
    visual_style: str = "dark-tech",
    svg_max_workers: int = None,
    on_progress: Optional[Callable[[dict], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Generate SVGs page by page. This is the Chrys Step 6 replacement.

    Returns: {"ok": True/False, "svg_count": N, "project_path": str, "errors": [...]}
    """
    def emit(step, status, message, data=None):
        if on_progress:
            on_progress({"step": step, "status": status, "message": message, "data": data or {}})

    emit(5, "running", "Executor Phase: initializing project...")

    project_dir = Path(project_path)
    svg_output = project_dir / "svg_output"
    svg_output.mkdir(parents=True, exist_ok=True)
    staged_template_assets = _stage_template_assets(template, svg_output)

    # Write spec files
    (project_dir / "spec_lock.md").write_text(spec_lock_content, encoding="utf-8")
    (project_dir / "design_spec.md").write_text(design_spec_content, encoding="utf-8")

    # Parse pages
    pages = _parse_pages_from_outline(final_outline)
    if not pages:
        emit(5, "error", "No pages found in outline")
        return {"ok": False, "svg_count": 0, "project_path": project_path, "errors": ["Empty outline"]}

    total_pages = len(pages)
    emit(5, "running", f"Generating {total_pages} pages...", {"total_pages": total_pages})
    phase_start = time.time()
    _write_log("ppt_executor_svg_phase_start", {
        "project_path": project_path,
        "svg_output": str(svg_output),
        "total_pages": total_pages,
        "mode": mode,
        "visual_style": visual_style,
        "final_outline_chars": len(final_outline or ""),
        "spec_lock_chars": len(spec_lock_content or ""),
        "design_spec_chars": len(design_spec_content or ""),
        "llm_timeout_seconds": LLM_REQ_TIMEOUT_MAX_SECONDS,
        "llm_max_tokens": LLM_MAX_TOKENS_SVG,
        "max_retries": SVG_GENERATION_MAX_RETRIES,
    })

    # Build system prompt once — inject mode + visual_style
    system_prompt = _build_executor_system_prompt(mode=mode, visual_style=visual_style)

    # Extract §IX context from design_spec for cross-page awareness
    design_spec_context = _extract_design_spec_context(design_spec_content)
    template_mappings = _infer_template_mappings(pages, intent or {}, visual_style, template)
    _write_log("ppt_executor_template_mappings", {
        "layouts": template_mappings.get("layouts", {}),
        "charts": template_mappings.get("charts", {}),
        "intent_topic": (intent or {}).get("topic", ""),
        "intent_audience": (intent or {}).get("audience", ""),
        "intent_scenario": (intent or {}).get("scenario", ""),
        "template": template,
        "staged_template_assets": staged_template_assets,
        "skill_dir": SKILL_DIR,
    })

    # Adaptive concurrency control: reduce parallelism on API failure (e.g. rate-limit)
    _concurrency_lock = threading.Lock()
    _concurrency_limit = min(svg_max_workers or SVG_GENERATION_MAX_WORKERS, total_pages)
    _concurrency_active = 0

    def _acquire_slot():
        """Block until a concurrency slot is available."""
        nonlocal _concurrency_active
        while True:
            with _concurrency_lock:
                if _concurrency_active < _concurrency_limit:
                    _concurrency_active += 1
                    return
            time.sleep(0.15)

    def _release_slot(decrease: bool = False):
        """Release a concurrency slot. If decrease=True and above minimum, also lower the limit."""
        nonlocal _concurrency_active, _concurrency_limit
        with _concurrency_lock:
            _concurrency_active -= 1
            if decrease and _concurrency_limit > SVG_CONCURRENCY_MIN:
                _concurrency_limit -= 1
                _log(f"Concurrency reduced to {_concurrency_limit} after API failure (min={SVG_CONCURRENCY_MIN})")

    # Parallel page generation via ThreadPoolExecutor
    def _generate_one_page(page_info: dict) -> dict:
        """Generate a single page's SVG (called from worker thread)."""
        # Check cancellation before starting this page
        if cancel_check and cancel_check():
            i = page_info["index"]
            return {"index": i, "ok": False, "error": "cancelled", "svg": None, "filename": None}
        i = page_info["index"]
        page = page_info["page"]
        page_num = i + 1
        page_key = f"P{page_num:02d}"
        page["layout_template"] = template_mappings.get("layouts", {}).get(page_key, "")
        page["chart_template"] = template_mappings.get("charts", {}).get(page_key, "")
        page_start = time.time()
        page_title = page.get("title", "")
        page_file_stem = _safe_file_stem(page_title, max_len=40, fallback=f"page_{page_num:02d}")

        emit(5, "running",
             f"生成第 {page_num}/{total_pages} 页: {page.get('title', '')[:30]}",
             {"current_page": page_num, "total_pages": total_pages})

        _write_log("ppt_executor_svg_page_start", {
            "page_num": page_num,
            "total_pages": total_pages,
            "title": page_title,
            "page_type": page.get("type") or page.get("slide_type"),
            "layout": page.get("layout"),
            "rhythm": page.get("rhythm"),
            "layout_template": page.get("layout_template", ""),
            "chart_template": page.get("chart_template", ""),
            "bullet_count": len(page.get("bullets") or []),
        })

        page["rhythm"] = "anchor" if page_num in (1, total_pages) else "dense"

        svg_code = None
        response = None
        attempts_used = 0
        api_failed = False
        simplified_retry = False
        last_failure_reason = ""
        for retry in range(SVG_GENERATION_MAX_RETRIES + 1):
            user_prompt = _build_page_prompt(
                page_index=page_num,
                total_pages=total_pages,
                page_info=page,
                spec_lock_lines=spec_lock_content,
                design_spec_context=design_spec_context,
                template_context=_build_template_context(page, simplified=simplified_retry),
                simplified=simplified_retry,
            )
            _acquire_slot()
            try:
                attempt_start = time.time()
                _write_log("ppt_executor_svg_llm_attempt_start", {
                    "page_num": page_num,
                    "total_pages": total_pages,
                    "attempt": retry + 1,
                    "max_attempts": SVG_GENERATION_MAX_RETRIES + 1,
                    "title": page_title,
                    "system_prompt_chars": len(system_prompt or ""),
                    "user_prompt_chars": len(user_prompt or ""),
                    "temperature": LLM_TEMPERATURE_SVG,
                    "max_tokens": LLM_MAX_TOKENS_SVG,
                    "timeout_seconds": LLM_REQ_TIMEOUT_MAX_SECONDS,
                    "concurrency_limit": _concurrency_limit,
                    "simplified_retry": simplified_retry,
                    "last_failure_reason": last_failure_reason,
                })
                # Save prompts for debugging
                prompts_dir = project_dir / "svg_prompts"
                prompts_dir.mkdir(parents=True, exist_ok=True)
                suffix = f"_retry{retry}" if retry > 0 else ""
                prompt_file = prompts_dir / f"P{page_num:02d}__{page_file_stem[:30]}{suffix}.json"
                try:
                    prompt_file.write_text(json.dumps({
                        "page_num": page_num,
                        "title": page_title,
                        "attempt": retry + 1,
                        "system_prompt": system_prompt,
                        "user_prompt": user_prompt,
                        "system_prompt_chars": len(system_prompt or ""),
                        "user_prompt_chars": len(user_prompt or ""),
                        "max_tokens": LLM_MAX_TOKENS_SVG,
                        "temperature": LLM_TEMPERATURE_SVG,
                        "simplified_retry": simplified_retry,
                        "last_failure_reason": last_failure_reason,
                    }, ensure_ascii=False, indent=2), encoding="utf-8")
                except Exception:
                    pass

                call_meta = _call_llm_detailed(
                    system_prompt=system_prompt,
                    user_msg=user_prompt,
                    temperature=LLM_TEMPERATURE_SVG,
                    max_tokens=LLM_MAX_TOKENS_SVG,
                    timeout_seconds=LLM_REQ_TIMEOUT_MAX_SECONDS,
                )
                response = call_meta.get("content") if call_meta.get("ok") else None
                llm_elapsed = round(time.time() - attempt_start, 2)
                llm_diagnostics = {k: v for k, v in call_meta.items() if k != "content"}
                svg_code = _extract_svg(response or "")
                attempts_used = retry + 1
                # Detect timeout: no response AND elapsed >= timeout * 0.9
                is_timeout = (
                    llm_diagnostics.get("error_type") == "timeout"
                    or ((not response) and (llm_elapsed >= LLM_REQ_TIMEOUT_MAX_SECONDS * 0.9))
                )
                response_analysis = _analyze_svg_response(
                    response or "", llm_diagnostics.get("finish_reason", "")
                )
                missing_assets = _missing_template_assets(
                    svg_code or "", page.get("layout_template", "")
                ) if svg_code else []
                if missing_assets:
                    last_failure_reason = "missing_template_assets: " + ", ".join(missing_assets)
                    response_analysis["missing_template_assets"] = missing_assets
                    svg_code = None
                response_file_path = ""
                if response:
                    try:
                        resp_file = prompts_dir / f"P{page_num:02d}__{page_file_stem[:30]}_retry{retry}_response.txt"
                        resp_file.write_text(response, encoding="utf-8")
                        response_file_path = str(resp_file)
                    except Exception as exc:
                        response_file_path = f"save_failed: {exc}"
                _write_log("ppt_executor_svg_llm_attempt_done", {
                    "page_num": page_num,
                    "total_pages": total_pages,
                    "attempt": retry + 1,
                    "elapsed_seconds": llm_elapsed,
                    "response_chars": len(response or ""),
                    "svg_extracted": bool(svg_code),
                    "svg_chars": len(svg_code or ""),
                    "response_file": response_file_path,
                    "response_analysis": response_analysis,
                    "llm_diagnostics": llm_diagnostics,
                    "finish_reason": llm_diagnostics.get("finish_reason", ""),
                    "usage": llm_diagnostics.get("usage", {}),
                    "status_code": llm_diagnostics.get("status_code"),
                    "error_type": llm_diagnostics.get("error_type", ""),
                    "error_message": llm_diagnostics.get("error_message", "")[:1000],
                    "is_timeout": is_timeout,
                    "timeout_seconds": LLM_REQ_TIMEOUT_MAX_SECONDS,
                    "simplified_retry": simplified_retry,
                }, level="info" if svg_code else ("error" if is_timeout else "warning"))
                if svg_code:
                    _release_slot()
                    break
                should_simplify_next = bool(
                    is_timeout
                    or response_analysis.get("likely_truncated")
                    or not response
                    or not svg_code
                )
                if should_simplify_next and retry < SVG_GENERATION_MAX_RETRIES:
                    last_failure_reason = last_failure_reason or (
                        "timeout" if is_timeout else
                        "truncated" if response_analysis.get("likely_truncated") else
                        llm_diagnostics.get("error_type") or "svg_extract_failed"
                    )
                    if not simplified_retry:
                        simplified_retry = True
                        _write_log("ppt_executor_svg_simplified_retry_enabled", {
                            "page_num": page_num,
                            "next_attempt": retry + 2,
                            "reason": last_failure_reason,
                            "finish_reason": llm_diagnostics.get("finish_reason", ""),
                            "response_chars": len(response or ""),
                        }, level="warning")
                        emit(5, "running",
                             f"第 {page_num}/{total_pages} 页将切换为简化模板重试（{last_failure_reason}）",
                             {"current_page": page_num, "total_pages": total_pages,
                              "simplified_retry": True, "reason": last_failure_reason})
                if is_timeout:
                    _log(f"Page {page_num} TIMEOUT ({llm_elapsed:.1f}s >= {LLM_REQ_TIMEOUT_MAX_SECONDS}s), retry {retry+1}/{SVG_GENERATION_MAX_RETRIES}")
                    emit(5, "running",
                         f"第 {page_num}/{total_pages} 页超时 ({llm_elapsed:.0f}s)，正在重试 {retry+1}/{SVG_GENERATION_MAX_RETRIES}...",
                         {"current_page": page_num, "total_pages": total_pages, "is_timeout": True})
                else:
                    _log(f"Page {page_num} SVG extraction failed, retry {retry+1}/{SVG_GENERATION_MAX_RETRIES}")
                _write_log("ppt_executor_svg_extract_failed", {
                    "page_num": page_num,
                    "total_pages": total_pages,
                    "attempt": retry + 1,
                    "response_chars": len(response or ""),
                    "response_file": response_file_path,
                    "response_analysis": response_analysis,
                    "llm_diagnostics": llm_diagnostics,
                    "finish_reason": llm_diagnostics.get("finish_reason", ""),
                    "usage": llm_diagnostics.get("usage", {}),
                    "status_code": llm_diagnostics.get("status_code"),
                    "error_type": llm_diagnostics.get("error_type", ""),
                    "error_message": llm_diagnostics.get("error_message", "")[:1000],
                    "is_timeout": is_timeout,
                    "simplified_retry": simplified_retry,
                    "next_retry_simplified": simplified_retry and retry < SVG_GENERATION_MAX_RETRIES,
                    "last_failure_reason": last_failure_reason,
                }, level="warning")
                # Failed to get usable SVG — could be API issue or model output issue
                api_failed = not response  # only treat "no response at all" as API-level failure
                _release_slot(decrease=api_failed)
            except Exception:
                _release_slot(decrease=True)
                raise

        page_elapsed = round(time.time() - page_start, 2)

        if not svg_code:
            # Determine failure reason
            total_timeouts = sum(1 for r in range(SVG_GENERATION_MAX_RETRIES + 1)
                                 if not response and (page_elapsed / (SVG_GENERATION_MAX_RETRIES + 1)) >= LLM_REQ_TIMEOUT_MAX_SECONDS * 0.9)
            is_timeout_failure = total_timeouts >= (SVG_GENERATION_MAX_RETRIES + 1) * 0.5  # Most attempts were timeouts
            error_type = "timeout" if is_timeout_failure else "llm_error"
            error_msg = f"Page {page_num}/{total_pages} [{page_title[:30]}]: "
            if is_timeout_failure:
                error_msg += f"LLM 超时 ({LLM_REQ_TIMEOUT_MAX_SECONDS}s)，已重试 {SVG_GENERATION_MAX_RETRIES} 次"
            else:
                error_msg += f"生成失败，已重试 {SVG_GENERATION_MAX_RETRIES} 次"
            _log(error_msg)
            _write_log("ppt_executor_svg_page_failed", {
                "page_num": page_num,
                "total_pages": total_pages,
                "title": page_title,
                "elapsed_seconds": page_elapsed,
                "attempts": SVG_GENERATION_MAX_RETRIES + 1,
                "error": error_msg,
                "error_type": error_type,
                "is_timeout": is_timeout_failure,
                "simplified_retry_used": simplified_retry,
                "last_failure_reason": last_failure_reason,
            }, level="error")
            # Emit to frontend details panel
            emit(5, "running",
                 f"❌ 第 {page_num}/{total_pages} 页失败: {error_type}",
                 {"current_page": page_num, "total_pages": total_pages,
                  "page_num": page_num, "title": page_title,
                  "error_type": error_type, "error_msg": error_msg,
                  "simplified_retry_used": simplified_retry,
                  "last_failure_reason": last_failure_reason})
            return {"page_num": page_num, "ok": False, "error": error_msg,
                    "title": page_title, "error_type": error_type}

        # Write SVG file
        safe_title = page_file_stem
        filename = f"P{page_num:02d}_{safe_title}.svg"
        filepath = svg_output / filename
        filepath.write_text(svg_code, encoding="utf-8")

        _log(f"Page {page_num}/{total_pages} generated: {filename} ({len(svg_code)} chars)")
        _write_log("ppt_executor_svg_page_done", {
            "page_num": page_num,
            "total_pages": total_pages,
            "title": page_title,
            "filename": filename,
            "filepath": str(filepath),
            "elapsed_seconds": page_elapsed,
            "svg_chars": len(svg_code),
            "svg_file_bytes": filepath.stat().st_size if filepath.exists() else 0,
            "attempts_used": attempts_used,
        })
        emit(5, "slide_preview",
             f"Page {page_num}/{total_pages} preview ready: {page_title[:30]}",
             {
                 "current_page": page_num,
                 "total_pages": total_pages,
                 "page_num": page_num,
                 "title": page_title,
                 "filename": filename,
                 "filepath": str(filepath),
                 "svg": svg_code,
             })

        return {"page_num": page_num, "ok": True, "filename": filename,
                "filepath": str(filepath), "title": page_title}

    # Submit all pages to thread pool (gate actual API concurrency via adaptive semaphore)
    page_inputs = [{"index": i, "page": dict(page)} for i, page in enumerate(pages)]
    pool_size = min(svg_max_workers or SVG_GENERATION_MAX_WORKERS, total_pages)

    results = {}
    errors = []
    with ThreadPoolExecutor(max_workers=pool_size) as executor:
        futures = {executor.submit(_generate_one_page, pi): pi["index"] for pi in page_inputs}
        for future in as_completed(futures):
            result = future.result()
            results[result["page_num"]] = result

    # Reorder and collect
    generated_pages = []
    for page_num in sorted(results.keys()):
        r = results[page_num]
        if r["ok"]:
            generated_pages.append({
                "page_num": r["page_num"],
                "title": r["title"],
                "filename": r["filename"],
                "filepath": r["filepath"],
            })
        else:
            errors.append(r.get("error", f"Page {page_num}: unknown error"))

    emit(5, "done",
         f"SVG generation complete: {len(generated_pages)}/{total_pages} pages",
         {"generated": len(generated_pages), "total": total_pages, "errors": errors})
    _write_log("ppt_executor_svg_phase_done", {
        "total_pages": total_pages,
        "generated": len(generated_pages),
        "failed": len(errors),
        "elapsed_seconds": round(time.time() - phase_start, 2),
        "errors": errors,
        "generated_pages": generated_pages,
    }, level="info" if generated_pages else "error")

    return {
        "ok": len(generated_pages) > 0,
        "svg_count": len(generated_pages),
        "total_pages": total_pages,
        "project_path": project_path,
        "generated_pages": generated_pages,
        "errors": errors,
    }


def _extract_design_spec_context(design_spec: str) -> str:
    """Extract key context from design_spec for prompt efficiency."""
    # Take §I-VI and §XI (technical constraints)
    sections = design_spec.split("## ")
    relevant = []
    for section in sections:
        if section.startswith("I.") or section.startswith("II.") or \
           section.startswith("III.") or section.startswith("IV.") or \
           section.startswith("XI."):
            relevant.append("## " + section)
    return "\n\n".join(relevant) if relevant else design_spec[:3000]


# ---------------------------------------------------------------------------
# Quality check phase
# ---------------------------------------------------------------------------

def quality_check_phase(
    project_path: str,
    on_progress: Optional[Callable[[dict], None]] = None,
) -> Dict[str, Any]:
    """
    Run svg_quality_checker.py and attempt auto-fix for errors.
    Returns {"ok": True/False, "errors": int, "warnings": int, "fixed": int}
    """
    def emit(step, status, message, data=None):
        if on_progress:
            on_progress({"step": step, "status": status, "message": message, "data": data or {}})

    emit(5.5, "running", "Quality checking SVGs...")

    checker_script = os.path.join(SKILL_DIR, "scripts", "svg_quality_checker.py")
    project_dir = Path(project_path)

    if not os.path.exists(checker_script):
        error_msg = f"Quality checker not found: {checker_script}"
        _log(error_msg)
        emit(5.5, "error", error_msg)
        return {"ok": False, "errors": 1, "warnings": 0, "fixed": 0, "error": error_msg}

    for retry in range(SVG_QUALITY_MAX_RETRIES + 1):
        try:
            result = subprocess.run(
                [sys.executable, checker_script, str(project_dir / "svg_output")],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
                cwd=project_dir,
            )
            output = (result.stdout or "") + "\n" + (result.stderr or "")

            _log(f"Quality check (attempt {retry+1}): exit={result.returncode}")

            if result.returncode == 0:
                emit(5.5, "done", "Quality check passed")
                return {"ok": True, "errors": 0, "warnings": 0, "fixed": 0}

            # Parse errors
            error_count = output.count("error")
            warning_count = output.count("warning")

            if retry >= SVG_QUALITY_MAX_RETRIES:
                emit(5.5, "done",
                     f"Quality check: {error_count} errors, {warning_count} warnings (max retries exceeded)",
                     {"errors": error_count, "warnings": warning_count})
                return {"ok": False, "errors": error_count, "warnings": warning_count, "fixed": 0}

            # Try to fix
            emit(5.5, "running",
                 f"Quality check found issues, fixing (attempt {retry+1})...",
                 {"errors": error_count, "warnings": warning_count})

            _auto_fix_svgs(project_dir / "svg_output", output)

        except subprocess.TimeoutExpired:
            emit(5.5, "error", "Quality check timed out")
            return {"ok": False, "errors": 1, "warnings": 0, "fixed": 0, "error": "timeout"}
        except Exception as e:
            _log(f"Quality check failed: {e}")
            emit(5.5, "done", f"Quality check error: {e}")
            return {"ok": False, "errors": 1, "warnings": 0, "fixed": 0}

    return {"ok": False, "errors": 1, "warnings": 0, "fixed": 0}


def _auto_fix_svgs(svg_dir: Path, checker_output: str):
    """Attempt automatic fixes for common SVG errors."""
    # Parse error messages to find problematic files
    error_files = set()
    for line in checker_output.split("\n"):
        # Typical format: "file.svg:12: error: rgba() is forbidden"
        match = re.search(r'([\w\-_]+\.svg):', line)
        if match and ("error" in line.lower() or "forbidden" in line.lower()):
            error_files.add(match.group(1))

    for filename in error_files:
        filepath = svg_dir / filename
        if not filepath.exists():
            continue
        try:
            content = filepath.read_text(encoding="utf-8")
            fixed = _fix_common_svg_issues(content)
            if fixed != content:
                filepath.write_text(fixed, encoding="utf-8")
                _log(f"Auto-fixed: {filename}")
        except Exception as e:
            _log(f"Failed to fix {filename}: {e}")


def _fix_common_svg_issues(content: str) -> str:
    """Fix common SVG issues that the checker would report."""
    # Remove rgba() — replace with hex + opacity (basic approach)
    # Note: this is a simple replacement; complex rgba gradients won't be handled
    content = re.sub(
        r'fill="rgba\(([^)]+)\)"',
        lambda m: _rgba_to_hex_fill(m.group(1)),
        content,
    )

    # Fix common HTML entities
    replacements = {
        "&mdash;": "—",
        "&ndash;": "–",
        "&copy;": "©",
        "&reg;": "®",
        "&nbsp;": " ",  # NBSP
        "&hellip;": "…",
        "&bull;": "•",
        "&rarr;": "→",
        "&larr;": "←",
        "&middot;": "·",
    }
    for entity, unicode_char in replacements.items():
        content = content.replace(entity, unicode_char)

    return content


def _rgba_to_hex_fill(rgba_str: str) -> str:
    """Convert rgba(r,g,b,a) to fill='#HEX' fill-opacity='a'."""
    parts = [p.strip() for p in rgba_str.split(",")]
    if len(parts) >= 3:
        try:
            r, g, b = int(parts[0]), int(parts[1]), int(parts[2])
            a = float(parts[3]) if len(parts) >= 4 else 1.0
            hex_color = f"#{r:02X}{g:02X}{b:02X}"
            return f'fill="{hex_color}" fill-opacity="{a:.3f}"'
        except (ValueError, IndexError):
            pass
    return f'fill="{rgba_str}"'  # fallback


# ---------------------------------------------------------------------------
# Speaker notes generation
# ---------------------------------------------------------------------------

def generate_speaker_notes(
    project_path: str,
    final_outline: str,
    on_progress: Optional[Callable[[dict], None]] = None,
) -> Dict[str, Any]:
    """Generate speaker notes in conversational Chinese."""
    def emit(step, status, message, data=None):
        if on_progress:
            on_progress({"step": step, "status": status, "message": message, "data": data or {}})

    emit(5.8, "running", "Generating speaker notes...")

    project_dir = Path(project_path)
    notes_dir = project_dir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)

    pages = _parse_pages_from_outline(final_outline)
    if not pages:
        return {"ok": False, "error": "No pages"}

    system_prompt = """\
You are a professional presentation speaker notes writer. Write notes in conversational Chinese.
Style: natural, like talking to an audience — not reading a script. 
Use storytelling: scenario → conflict → resolution arc per page.
Make data conversational: "30%" → "nearly one-third", "2.5x" → "more than doubled".
NO bracketed markers. NO "Key points:" / "Duration:" lines.
Keep each page's notes to 150-300 characters."""

    all_notes = []

    for i, page in enumerate(pages):
        page_num = i + 1
        title = page.get("title", f"第{page_num}页")
        content = page.get("content", [])
        content_text = " | ".join(content) if content else title

        if page_num == 1:
            context_hint = "This is the COVER page. Write a warm opening, introducing the topic naturally."
        elif page_num == len(pages):
            context_hint = "This is the CLOSING page. Write a concise summary with forward-looking perspective."
        else:
            context_hint = "Transition naturally from the previous page."

        user_prompt = f"""\
Page {page_num}/{len(pages)}: {title}
Content: {content_text}
Context: {context_hint}

Write the speaker notes:"""

        notes_text = _call_llm(
            system_prompt=system_prompt,
            user_msg=user_prompt,
            temperature=LLM_TEMPERATURE_CREATIVE,
            max_tokens=LLM_MAX_TOKENS_NOTES,
            timeout_seconds=LLM_REQ_TIMEOUT_NORMAL_SECONDS,
        )

        if notes_text:
            all_notes.append(f"# {page_num:02d}_{_slug(title)}\n\n{notes_text.strip()}\n")
        else:
            all_notes.append(f"# {page_num:02d}_{_slug(title)}\n\n{title} — {content_text}\n")

    # Write combined notes
    total_md = notes_dir / "total.md"
    total_md.write_text("\n---\n\n".join(all_notes), encoding="utf-8")

    emit(5.8, "done", f"Speaker notes generated: {len(all_notes)} pages")

    return {"ok": True, "notes_count": len(all_notes)}


def _slug(text: str) -> str:
    """Convert text to a safe filename slug."""
    return _safe_file_stem(text, max_len=40)


# ---------------------------------------------------------------------------
# Post-processing phase (scripts)
# ---------------------------------------------------------------------------

def post_process_phase(
    project_path: str,
    on_progress: Optional[Callable[[dict], None]] = None,
) -> Dict[str, Any]:
    """
    Run ppt-master post-processing scripts:
    1. total_md_split.py
    2. finalize_svg.py
    3. svg_to_pptx.py → outputs PPTX file
    """
    def emit(step, status, message, data=None):
        if on_progress:
            on_progress({"step": step, "status": status, "message": message, "data": data or {}})

    emit(6, "running", "Post-processing: running scripts...")

    scripts = {
        "total_md_split": os.path.join(SKILL_DIR, "scripts", "total_md_split.py"),
        "finalize_svg": os.path.join(SKILL_DIR, "scripts", "finalize_svg.py"),
        "svg_to_pptx": os.path.join(SKILL_DIR, "scripts", "svg_to_pptx.py"),
    }

    # Check scripts exist
    missing = [name for name, path in scripts.items() if not os.path.exists(path)]
    if missing:
        error_msg = f"Required scripts not found: {', '.join(missing)}. Check SKILL_DIR={SKILL_DIR}"
        _log(error_msg)
        emit(6, "error", error_msg)
        return {"ok": False, "error": error_msg, "missing_scripts": missing}

    project_dir = Path(project_path)

    for step_name, script_path in [
        ("total_md_split", scripts["total_md_split"]),
        ("finalize_svg", scripts["finalize_svg"]),
    ]:
        emit(6, "running", f"Running {step_name}.py...")

        try:
            result = subprocess.run(
                [sys.executable, script_path, str(project_dir)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                cwd=project_dir,
            )
            if result.returncode != 0:
                stderr = (result.stderr or "")[-500:]
                _log(f"{step_name}.py exited with code {result.returncode}: {stderr}")
                error_msg = f"{step_name}.py failed with code {result.returncode}: {stderr}"
                if step_name == "finalize_svg":
                    emit(6, "error", error_msg, {"exit_code": result.returncode})
                    return {"ok": False, "error": error_msg, "project_path": project_path}
                emit(6, "running", error_msg, {"exit_code": result.returncode})
            else:
                _log(f"{step_name}.py completed successfully")
        except subprocess.TimeoutExpired:
            error_msg = f"{step_name}.py timed out"
            if step_name == "finalize_svg":
                emit(6, "error", error_msg)
                return {"ok": False, "error": error_msg, "project_path": project_path}
            emit(6, "running", error_msg)
        except Exception as e:
            _log(f"{step_name}.py error: {e}")
            error_msg = f"{step_name}.py error: {e}"
            if step_name == "finalize_svg":
                emit(6, "error", error_msg)
                return {"ok": False, "error": error_msg, "project_path": project_path}
            emit(6, "running", error_msg)

    # svg_to_pptx: try native first, fall back to legacy on failure
    pptx_script = scripts["svg_to_pptx"]
    for mode_label, extra_args in [("native", []), ("legacy", ["--only", "legacy"])]:
        emit(6, "running", f"Running svg_to_pptx.py ({mode_label})...")
        try:
            result = subprocess.run(
                [sys.executable, pptx_script, str(project_dir)] + extra_args,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                cwd=project_dir,
            )
            if result.returncode != 0:
                stderr = (result.stderr or "")[-500:]
                _log(f"svg_to_pptx.py ({mode_label}) exited with code {result.returncode}: {stderr}")
                emit(6, "running",
                     f"svg_to_pptx.py ({mode_label}) completed with warnings (code {result.returncode})",
                     {"exit_code": result.returncode, "mode": mode_label})
            else:
                _log(f"svg_to_pptx.py ({mode_label}) completed successfully")
        except subprocess.TimeoutExpired:
            _log(f"svg_to_pptx.py ({mode_label}) timed out")
            emit(6, "running", f"svg_to_pptx.py ({mode_label}) timed out")
        except Exception as e:
            _log(f"svg_to_pptx.py ({mode_label}) error: {e}")
            emit(6, "running", f"svg_to_pptx.py ({mode_label}) error: {e}")

        # Check if PPTX was generated after this attempt
        exports_dir = project_dir / "exports"
        pptx_files = list(exports_dir.glob("*.pptx")) if exports_dir.exists() else []
        pptx_files = [f for f in pptx_files if "_svg" not in f.stem]
        if pptx_files:
            pptx_path = str(pptx_files[0])
            emit(6, "done", f"PPTX exported ({mode_label}): {pptx_path}",
                 {"pptx_path": pptx_path, "mode": mode_label})
            return {"ok": True, "pptx_path": pptx_path, "project_path": project_path}

    # Both modes failed
    emit(6, "done", "Post-processing complete (PPTX not found in exports/)",
         {"project_path": project_path})
    return {"ok": False, "error": "PPTX not found in exports/", "project_path": project_path, "pptx_path": None}


# ---------------------------------------------------------------------------
# Master entry point
# ---------------------------------------------------------------------------

def generate_ppt(
    final_outline: str,
    intent: dict,
    template: str = "default",
    task_dir: str = "",
    reference_style: Dict[str, Any] = None,
    on_progress: Optional[Callable[[dict], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """
    Master entry point: generate a complete PPT from the reviewed outline.

    If reference_style is provided (extracted from a reference PPTX), it will be
    used for colors, fonts, and basic design choices instead of LLM defaults.

    Phases:
    1. Generate spec files (spec_lock.md + design_spec.md)
    2. Create project directory
    3. Executor: generate SVGs page by page
    4. Quality check
    5. Generate speaker notes
    6. Post-process & export PPTX

    Returns: {"ok": True/False, "pptx_path": str, "project_path": str, ...}
    """
    def emit(step, status, message, data=None):
        if on_progress:
            on_progress({"step": step, "status": status, "message": message, "data": data or {}})

    try:
        # Phase 1: Generate spec files
        emit(4.5, "running", "Generating design specification files...")
        specs = _generate_spec_files(final_outline, intent, template, reference_style)
        project_name = specs["project_name"]

        # Phase 2: Create project directory
        if not task_dir:
            task_dir = os.path.join(
                _get_task_base_dir(),
                f"ppt_project_{project_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
            )
        project_path = os.path.abspath(task_dir)
        os.makedirs(project_path, exist_ok=True)
        emit(4.5, "done", f"Project created: {project_name} ({specs['page_count']} pages)",
             {"project_path": project_path, "page_count": specs["page_count"]})

        # Phase 3: Executor — generate SVGs
        svg_max_workers = max(1, int((intent or {}).get("svg_max_workers", SVG_GENERATION_MAX_WORKERS) or SVG_GENERATION_MAX_WORKERS))
        executor_result = executor_phase(
            project_path=project_path,
            spec_lock_content=specs["spec_lock"],
            design_spec_content=specs["design_spec"],
            final_outline=final_outline,
            intent=intent,
            template=template,
            mode=specs.get("mode", "briefing"),
            visual_style=specs.get("visual_style", "dark-tech"),
            svg_max_workers=svg_max_workers,
            on_progress=on_progress,
            cancel_check=cancel_check,
        )

        if not executor_result.get("ok"):
            return {
                "ok": False,
                "error": "Executor phase failed",
                "project_path": project_path,
                **executor_result,
            }

        # Phase 4: Quality check
        qc_result = quality_check_phase(project_path, on_progress=on_progress)
        if not qc_result.get("ok"):
            return {
                "ok": False,
                "error": "SVG quality check failed",
                "project_path": project_path,
                "quality_check": qc_result,
            }

        # Phase 5: Speaker notes
        notes_result = generate_speaker_notes(project_path, final_outline, on_progress=on_progress)

        # Phase 6: Post-process & export
        export_result = post_process_phase(project_path, on_progress=on_progress)
        if not export_result.get("ok") or not export_result.get("pptx_path"):
            return {
                "ok": False,
                "error": export_result.get("error") or "PPTX export failed",
                "project_path": project_path,
                "export": export_result,
            }

        pptx_path = export_result.get("pptx_path")
        emit(10, "done",
             f"PPT generation complete! {'File: ' + pptx_path if pptx_path else 'See project directory'}",
             {"pptx_path": pptx_path, "project_path": project_path,
              "svg_count": executor_result.get("svg_count", 0),
              "notes_count": notes_result.get("notes_count", 0)})

        return {
            "ok": True,
            "pptx_path": pptx_path,
            "project_path": project_path,
            "svg_count": executor_result.get("svg_count", 0),
            "total_pages": executor_result.get("total_pages", 0),
            "errors": executor_result.get("errors", []),
        }

    except Exception as e:
        _log(f"generate_ppt failed: {e}\n{traceback.format_exc()}")
        emit(99, "error", f"PPT generation failed: {str(e)[:200]}")
        return {"ok": False, "error": str(e)}


def _get_task_base_dir() -> str:
    """Get the base directory for PPT task outputs."""
    try:
        fn = _refs.get("_get_current_project")
        if fn:
            project = fn()
            if project and project.get("path"):
                return os.path.join(project["path"], "ppt-projects")
    except Exception:
        pass
    return os.path.join(os.getcwd(), "ppt-projects")
