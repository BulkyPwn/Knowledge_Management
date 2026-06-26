import os
from flask import Blueprint, request, jsonify

from .neo4j_client import get_neo4j_client
from .neo4j_sync import Neo4jWikiSync

neo4j_bp = Blueprint("neo4j", __name__, url_prefix="/api/v1/neo4j")

_sync: Neo4jWikiSync = None


def _get_sync() -> Neo4jWikiSync:
    global _sync
    if _sync is None:
        _sync = Neo4jWikiSync()
    return _sync


def _check_available():
    client = get_neo4j_client()
    if client is None or not client.available:
        return (
            jsonify(
                {
                    "success": False,
                    "message": "Neo4j is not available. Set NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD environment variables.",
                }
            ),
            503,
        )
    return None, client


@neo4j_bp.route("/status", methods=["GET"])
def neo4j_status():
    client = get_neo4j_client()
    if client is None:
        return jsonify(
            {"success": False, "available": False, "message": "Neo4j not initialized"}
        )
    if not client.available:
        return jsonify(
            {
                "success": True,
                "available": False,
                "message": f"Cannot connect to Neo4j at {client.uri}",
            }
        )
    stats = client.get_graph_stats()
    return jsonify(
        {
            "success": True,
            "available": True,
            "uri": client.uri,
            "database": client.database,
            "stats": stats,
        }
    )


@neo4j_bp.route("/sync/project", methods=["POST"])
def sync_project():
    err, client = _check_available()
    if err:
        return err

    data = request.get_json() or {}
    project_name = data.get("projectName")
    wiki_dir = data.get("wikiDir")
    clear_first = data.get("clearFirst", False)

    if not project_name:
        return jsonify({"success": False, "message": "projectName is required"}), 400
    if not wiki_dir:
        return jsonify({"success": False, "message": "wikiDir is required"}), 400
    if not os.path.isdir(wiki_dir):
        return jsonify({"success": False, "message": f"wikiDir not found: {wiki_dir}"}), 400

    sync = _get_sync()
    result = sync.sync_project(project_name, wiki_dir, clear_first=clear_first)
    return jsonify(result)


@neo4j_bp.route("/sync/page", methods=["POST"])
def sync_page():
    err, client = _check_available()
    if err:
        return err

    data = request.get_json() or {}
    project_name = data.get("projectName")
    title = data.get("title")
    content = data.get("content")
    filepath = data.get("path")

    if not project_name:
        return jsonify({"success": False, "message": "projectName is required"}), 400
    if not title:
        return jsonify({"success": False, "message": "title is required"}), 400
    if not content:
        return jsonify({"success": False, "message": "content is required"}), 400

    sync = _get_sync()
    result = sync.sync_page(project_name, title, content, filepath=filepath)
    return jsonify(result)


@neo4j_bp.route("/sync/page/<path:title>", methods=["DELETE"])
def delete_page_from_graph(title):
    err, client = _check_available()
    if err:
        return err

    sync = _get_sync()
    result = sync.delete_page(title)
    return jsonify(result)


@neo4j_bp.route("/graph/project/<project_name>", methods=["GET"])
def get_project_graph(project_name):
    err, client = _check_available()
    if err:
        return err

    result = client.run_query(
        "MATCH (n:WikiPage {project: $project}) "
        "OPTIONAL MATCH (n)-[r:LINKS_TO]->(m:WikiPage {project: $project}) "
        "RETURN n, r, m",
        {"project": project_name},
    )

    nodes_list = []
    for node in result.nodes:
        nodes_list.append(
            {
                "id": node.id,
                "labels": node.labels,
                "properties": node.properties,
            }
        )

    edges_list = []
    for edge in result.edges:
        edges_list.append(
            {
                "source": edge.source_id,
                "target": edge.target_id,
                "type": edge.type,
                "properties": edge.properties,
            }
        )

    return jsonify(
        {
            "success": True,
            "project": project_name,
            "nodes": nodes_list,
            "edges": edges_list,
            "node_count": len(nodes_list),
            "edge_count": len(edges_list),
        }
    )


@neo4j_bp.route("/graph/neighbors/<title>", methods=["GET"])
def get_neighbors(title):
    err, client = _check_available()
    if err:
        return err

    depth = request.args.get("depth", 1, type=int)
    limit = request.args.get("limit", 50, type=int)

    result = client.get_neighbors(title, depth=depth, limit=limit)

    nodes_list = []
    seen = set()
    for node in result.nodes:
        if node.id not in seen:
            seen.add(node.id)
            nodes_list.append(
                {
                    "id": node.id,
                    "labels": node.labels,
                    "properties": node.properties,
                }
            )

    edges_list = []
    for edge in result.edges:
        edges_list.append(
            {
                "source": edge.source_id,
                "target": edge.target_id,
                "type": edge.type,
                "properties": edge.properties,
            }
        )

    return jsonify(
        {
            "success": True,
            "title": title,
            "depth": depth,
            "nodes": nodes_list,
            "edges": edges_list,
        }
    )


@neo4j_bp.route("/graph/path", methods=["GET"])
def find_path():
    err, client = _check_available()
    if err:
        return err

    source = request.args.get("source")
    target = request.args.get("target")
    max_depth = request.args.get("maxDepth", 4, type=int)
    limit = request.args.get("limit", 10, type=int)

    if not source or not target:
        return jsonify({"success": False, "message": "source and target are required"}), 400

    result = client.find_paths(source, target, max_depth=max_depth, limit=limit)

    nodes_list = []
    seen = set()
    for node in result.nodes:
        if node.id not in seen:
            seen.add(node.id)
            nodes_list.append(
                {
                    "id": node.id,
                    "labels": node.labels,
                    "properties": node.properties,
                }
            )

    edges_list = []
    for edge in result.edges:
        edges_list.append(
            {
                "source": edge.source_id,
                "target": edge.target_id,
                "type": edge.type,
                "properties": edge.properties,
            }
        )

    return jsonify(
        {
            "success": True,
            "source": source,
            "target": target,
            "nodes": nodes_list,
            "edges": edges_list,
            "path_count": len(result.edges),
        }
    )


@neo4j_bp.route("/graph/search", methods=["GET"])
def search_nodes():
    err, client = _check_available()
    if err:
        return err

    keyword = request.args.get("keyword", "")
    labels = request.args.getlist("label") or None
    limit = request.args.get("limit", 20, type=int)

    if not keyword:
        return jsonify({"success": False, "message": "keyword is required"}), 400

    result = client.search_nodes(keyword, labels=labels, limit=limit)

    nodes_list = []
    for node in result.nodes:
        nodes_list.append(
            {
                "id": node.id,
                "labels": node.labels,
                "properties": node.properties,
            }
        )

    return jsonify({"success": True, "keyword": keyword, "nodes": nodes_list, "count": len(nodes_list)})


@neo4j_bp.route("/graph/stats", methods=["GET"])
def get_stats():
    err, client = _check_available()
    if err:
        return err

    stats = client.get_graph_stats()
    return jsonify({"success": True, "stats": stats})


@neo4j_bp.route("/graph/community/<algorithm>", methods=["GET"])
def community_detect(algorithm):
    err, client = _check_available()
    if err:
        return err

    valid = {"louvain", "pagerank", "betweenness"}
    if algorithm not in valid:
        return jsonify({"success": False, "message": f"Invalid algorithm. Choose from: {', '.join(sorted(valid))}"}), 400

    results = client.community_detect(algorithm)
    return jsonify({"success": True, "algorithm": algorithm, "results": results, "count": len(results)})


@neo4j_bp.route("/graph/clear/<project_name>", methods=["DELETE"])
def clear_project(project_name):
    err, client = _check_available()
    if err:
        return err

    ok = client.clear_project(project_name)
    return jsonify({"success": ok, "project": project_name})


@neo4j_bp.route("/cypher", methods=["POST"])
def run_cypher():
    err, client = _check_available()
    if err:
        return err

    data = request.get_json() or {}
    cypher = data.get("cypher", "")
    params = data.get("params", {})

    if not cypher:
        return jsonify({"success": False, "message": "cypher query is required"}), 400

    try:
        records = client.run(cypher, params)
        return jsonify({"success": True, "records": records, "count": len(records)})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400
