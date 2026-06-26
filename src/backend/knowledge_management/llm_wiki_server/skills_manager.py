"""
Skill 管理器
=============
从 skills/ 目录加载 Markdown 格式的技能定义文件。

每个 .md 文件包含：
- YAML front matter（可选）：name, description, tools_used, trigger_keywords
- Markdown body：技能指令内容，会被注入到 system prompt 中

示例：
---
name: 搜索导入
description: 搜索关键词并将结果导入知识库
tools_used: [web_search, fetch_url, knowledge_query]
trigger_keywords: [搜索, 导入, search, import]
---

# 搜索导入技能

当用户要求搜索并导入资料时，按以下步骤执行：
1. ...
"""

import os
import re
import json
from typing import List, Dict, Optional


_SKILLS_DIR = os.path.join(os.path.dirname(__file__), "skills")


def _parse_front_matter(content: str) -> tuple:
    """解析 YAML front matter（简易实现，不依赖 pyyaml）
    
    返回 (metadata_dict, body_str)
    """
    if not content.startswith("---"):
        return {}, content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content

    front = parts[1].strip()
    body = parts[2].strip()

    metadata = {}
    for line in front.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            # 解析列表 [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                try:
                    value = json.loads(value)
                except json.JSONDecodeError:
                    value = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
            # 解析布尔值
            elif value.lower() in ("true", "false"):
                value = value.lower() == "true"
            metadata[key] = value

    return metadata, body


def load_skills(skills_dir: str = None) -> List[Dict]:
    """加载所有 .md 技能文件
    
    返回：
    [
        {
            "id": "search-import",           # 文件名（无扩展名）
            "name": "搜索导入",
            "description": "...",
            "tools_used": ["web_search", ...],
            "trigger_keywords": ["搜索", ...],
            "content": "# 搜索导入技能\n...",
            "file_path": "skills/search-import.md",
        },
        ...
    ]
    """
    base_dir = skills_dir or _SKILLS_DIR
    skills = []

    if not os.path.isdir(base_dir):
        return skills

    for filename in sorted(os.listdir(base_dir)):
        if not filename.endswith(".md"):
            continue

        filepath = os.path.join(base_dir, filename)
        skill_id = filename[:-3]  # 去掉 .md

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                raw = f.read()
        except Exception:
            continue

        metadata, body = _parse_front_matter(raw)

        skills.append({
            "id": skill_id,
            "name": metadata.get("name", skill_id),
            "description": metadata.get("description", ""),
            "tools_used": metadata.get("tools_used", []),
            "trigger_keywords": metadata.get("trigger_keywords", []),
            "content": body,
            "file_path": filepath,
        })

    return skills


def get_skill_by_id(skill_id: str, skills_dir: str = None) -> Optional[Dict]:
    """按 ID 获取单个技能"""
    for skill in load_skills(skills_dir):
        if skill["id"] == skill_id:
            return skill
    return None


def match_skills(user_input: str, skills: List[Dict] = None, top_k: int = 2) -> List[Dict]:
    """根据用户输入匹配相关技能
    
    使用关键词匹配 + 名称/描述匹配
    """
    if skills is None:
        skills = load_skills()

    input_lower = user_input.lower()
    scored = []

    for skill in skills:
        score = 0

        # 关键词匹配
        for kw in skill.get("trigger_keywords", []):
            if kw.lower() in input_lower:
                score += 2

        # 名称匹配
        if skill.get("name") and skill["name"].lower() in input_lower:
            score += 3

        # 描述匹配
        desc = skill.get("description", "").lower()
        if desc and desc in input_lower:
            score += 1

        if score > 0:
            scored.append((score, skill))

    scored.sort(key=lambda x: -x[0])
    return [s for _, s in scored[:top_k]]


def build_skills_prompt(active_skills: List[Dict] = None) -> str:
    """将匹配的技能指令拼接到 system prompt 中"""
    if not active_skills:
        return ""

    parts = []
    for skill in active_skills:
        parts.append(f"## Skill: {skill['name']}\n{skill['content']}")

    if not parts:
        return ""

    return "\n\nYou have the following skills available. When the user's request matches a skill, follow its instructions:\n\n" + "\n\n---\n\n".join(parts)
