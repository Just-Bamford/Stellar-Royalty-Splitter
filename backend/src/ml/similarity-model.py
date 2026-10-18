#!/usr/bin/env python3
"""Simple recommendation similarity model for NFT collections and collaborators."""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict, Iterable, List, Sequence, Set


def normalize(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def to_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        items = value
    else:
        items = [value]
    return [normalize(item) for item in items if normalize(item)]


def jaccard_similarity(left: Iterable[str], right: Iterable[str]) -> float:
    left_set = set(left)
    right_set = set(right)
    if not left_set and not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


def string_similarity(left: Any, right: Any) -> float:
    left_value = normalize(left)
    right_value = normalize(right)
    if not left_value and not right_value:
        return 1.0
    if not left_value or not right_value:
        return 0.0
    if left_value == right_value:
        return 1.0
    if left_value in right_value or right_value in left_value:
        return 0.75
    return 0.0


def rarity_rank(value: Any) -> int:
    mapping = {
        "common": 1,
        "uncommon": 2,
        "rare": 3,
        "epic": 4,
        "legendary": 5,
        "mythic": 6,
    }
    return mapping.get(normalize(value), 0)


def numeric_similarity(left: float, right: float, scale: float = 250.0) -> float:
    if left is None or right is None:
        return 0.0
    delta = abs(float(left) - float(right))
    adjusted_scale = max(scale, abs(float(left)), abs(float(right)))
    return max(0.0, 1.0 - delta / adjusted_scale)


def calculate_collection_similarity(left: Dict[str, Any], right: Dict[str, Any]) -> float:
    left_meta = {
        "genre": normalize(left.get("genre")),
        "theme": normalize(left.get("theme")),
        "audience": normalize(left.get("audience")),
        "rarity": normalize(left.get("rarity")),
        "floor_price": float(left.get("floorPrice") or left.get("floor_price") or 0),
        "tags": to_list(left.get("tags") or left.get("keywords") or left.get("categories")),
    }
    right_meta = {
        "genre": normalize(right.get("genre")),
        "theme": normalize(right.get("theme")),
        "audience": normalize(right.get("audience")),
        "rarity": normalize(right.get("rarity")),
        "floor_price": float(right.get("floorPrice") or right.get("floor_price") or 0),
        "tags": to_list(right.get("tags") or right.get("keywords") or right.get("categories")),
    }

    weights = {
        "genre": 0.30,
        "tags": 0.20,
        "rarity": 0.15,
        "theme": 0.10,
        "audience": 0.10,
        "price": 0.15,
    }

    genre_score = string_similarity(left_meta["genre"], right_meta["genre"])
    tag_score = jaccard_similarity(left_meta["tags"], right_meta["tags"])
    rarity_score = max(0.0, 1.0 - abs(rarity_rank(left_meta["rarity"]) - rarity_rank(right_meta["rarity"])) / 6.0)
    theme_score = string_similarity(left_meta["theme"], right_meta["theme"])
    audience_score = string_similarity(left_meta["audience"], right_meta["audience"])
    price_score = numeric_similarity(left_meta["floor_price"], right_meta["floor_price"], 250.0)

    weighted = (
        genre_score * weights["genre"]
        + tag_score * weights["tags"]
        + rarity_score * weights["rarity"]
        + theme_score * weights["theme"]
        + audience_score * weights["audience"]
        + price_score * weights["price"]
    )

    total = sum(weights.values())
    return round(max(0.0, min(1.0, weighted / total)), 4)


def recommend_similar_collections(target: Dict[str, Any], collections: Sequence[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    recommendations = []
    for collection in collections:
        if collection.get("id") == target.get("id"):
            continue
        score = calculate_collection_similarity(target, collection)
        if score < 0.15:
            continue
        recommendations.append(
            {
                "id": collection.get("id") or collection.get("name"),
                "name": collection.get("name") or collection.get("id"),
                "score": round(score, 4),
                "confidence": round(min(1.0, score + 0.1), 4),
                "reason": "Shared aesthetic and metadata overlap",
                "type": "collection",
            }
        )
    recommendations.sort(key=lambda item: item["score"], reverse=True)
    return recommendations[:limit]


def recommend_collaborators(target_id: str, collaborators: Sequence[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    target = next((person for person in collaborators if person.get("id") == target_id or person.get("address") == target_id), None)
    target_projects = set()
    if target:
        for value in target.get("projects", []) or []:
            target_projects.add(normalize(value))

    recommendations = []
    for collaborator in collaborators:
        if collaborator.get("id") == target_id or collaborator.get("address") == target_id:
            continue
        shared_projects = [project for project in collaborator.get("projects", []) or [] if normalize(project) in target_projects]
        overlap = len(shared_projects) / max(1, max(len(target_projects), len(collaborator.get("projects", []) or [])))
        score = min(1.0, overlap * 0.8 + (0.2 if shared_projects else 0.0))
        if score <= 0:
            continue
        recommendations.append(
            {
                "id": collaborator.get("id") or collaborator.get("address") or collaborator.get("name"),
                "name": collaborator.get("name") or collaborator.get("id") or collaborator.get("address"),
                "score": round(score, 4),
                "confidence": round(min(1.0, score + 0.15), 4),
                "reason": "Collaborators who worked with you also worked with this collaborator",
                "type": "collaborator",
                "sharedProjects": len(shared_projects),
            }
        )
    recommendations.sort(key=lambda item: item["score"], reverse=True)
    return recommendations[:limit]


def generate_recommendations(payload: Dict[str, Any]) -> Dict[str, Any]:
    collection = payload.get("collection")
    collections = payload.get("collections") or []
    collaborator = payload.get("collaborator")
    collaborators = payload.get("collaborators") or []
    limit = int(payload.get("limit") or 5)

    recommendation_payload = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "collectionRecommendations": recommend_similar_collections(collection, collections, limit) if collection else [],
        "collaboratorRecommendations": recommend_collaborators(collaborator, collaborators, limit) if collaborator else [],
        "summary": {
            "totalCollectionRecommendations": len(recommend_similar_collections(collection, collections, limit)) if collection else 0,
            "totalCollaboratorRecommendations": len(recommend_collaborators(collaborator, collaborators, limit)) if collaborator else 0,
        },
    }
    return recommendation_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate NFT collection and collaborator recommendations.")
    parser.add_argument("--input", type=str, help="JSON payload to score.")
    args = parser.parse_args()

    payload = json.loads(args.input) if args.input else {}
    print(json.dumps(generate_recommendations(payload), indent=2))


if __name__ == "__main__":
    main()
