import os
import sys
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field


@dataclass
class GraphNode:
    id: str
    labels: List[str]
    properties: Dict[str, Any]


@dataclass
class GraphEdge:
    source_id: str
    target_id: str
    type: str
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphQueryResult:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    raw: Any = None


class Neo4jClient:
    def __init__(
        self,
        uri: Optional[str] = None,
        username: Optional[str] = None,
        password: Optional[str] = None,
        database: str = "neo4j",
    ):
        self.uri = uri or os.environ.get("NEO4J_URI", "bolt://127.0.0.1:7687")
        self.username = username or os.environ.get("NEO4J_USERNAME", "neo4j")
        self.password = password or os.environ.get("NEO4J_PASSWORD", "neo4j")
        self.database = database or os.environ.get("NEO4J_DATABASE", "neo4j")
        self._driver = None
        self._available = None

    @property
    def driver(self):
        if self._driver is None:
            from neo4j import GraphDatabase

            self._driver = GraphDatabase.driver(
                self.uri, auth=(self.username, self.password)
            )
        return self._driver

    @property
    def available(self) -> bool:
        if self._available is None:
            self._available = self._check_connection()
        return self._available

    def _check_connection(self) -> bool:
        try:
            self.run("RETURN 1 AS ok")
            return True
        except Exception:
            return False

    def close(self):
        if self._driver:
            self._driver.close()
            self._driver = None
            self._available = None

    def run(
        self,
        cypher: str,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        with self.driver.session(database=self.database) as session:
            result = session.run(cypher, parameters or {})
            return [record.data() for record in result]

    def run_query(self, cypher: str, parameters: Optional[Dict[str, Any]] = None) -> GraphQueryResult:
        nodes: Dict[str, GraphNode] = {}
        edges: List[GraphEdge] = []

        with self.driver.session(database=self.database) as session:
            result = session.run(cypher, parameters or {})
            raw_records = [record.data() for record in result]

            for record in raw_records:
                for key, value in record.items():
                    self._extract_graph_elements(value, nodes, edges)

        return GraphQueryResult(
            nodes=list(nodes.values()),
            edges=edges,
            raw=raw_records,
        )

    def _extract_graph_elements(
        self,
        value: Any,
        nodes: Dict[str, GraphNode],
        edges: List[GraphEdge],
    ):
        try:
            from neo4j.graph import Node, Relationship
        except ImportError:
            return

        if isinstance(value, Node):
            node_id = str(value.id)
            if node_id not in nodes:
                nodes[node_id] = GraphNode(
                    id=node_id,
                    labels=list(value.labels),
                    properties=dict(value),
                )
        elif isinstance(value, Relationship):
            edges.append(
                GraphEdge(
                    source_id=str(value.start_node.id),
                    target_id=str(value.end_node.id),
                    type=value.type,
                    properties=dict(value),
                )
            )
        elif isinstance(value, list):
            for item in value:
                self._extract_graph_elements(item, nodes, edges)
        elif isinstance(value, dict):
            for v in value.values():
                self._extract_graph_elements(v, nodes, edges)

    def upsert_node(
        self,
        node_id: str,
        labels: List[str],
        properties: Dict[str, Any],
    ) -> bool:
        label_str = ":".join(labels)
        merge_keys = {k: v for k, v in properties.items() if k in ("title", "id", "path")}
        if not merge_keys:
            merge_keys = {"__id": node_id}

        set_pairs = ", ".join(f"n.{k} = ${k}" for k in properties)
        merge_cond = "{" + ", ".join(f"{k}: ${k}" for k in merge_keys) + "}"

        cypher = f"MERGE (n:{label_str} {merge_cond}) SET {set_pairs}"
        try:
            self.run(cypher, properties)
            return True
        except Exception as e:
            sys.stderr.write(f"[neo4j] upsert_node failed: {e}\n")
            return False

    def delete_node(self, node_id: str, label: str = "WikiPage") -> bool:
        cypher = f"MATCH (n:{label} {{id: $id}}) DETACH DELETE n"
        try:
            self.run(cypher, {"id": node_id})
            return True
        except Exception as e:
            sys.stderr.write(f"[neo4j] delete_node failed: {e}\n")
            return False

    def upsert_relationship(
        self,
        source_id: str,
        target_id: str,
        rel_type: str,
        properties: Optional[Dict[str, Any]] = None,
        source_label: str = "WikiPage",
        target_label: str = "WikiPage",
    ) -> bool:
        props = properties or {}
        set_pairs = ", ".join(f"r.{k} = ${k}" for k in props)

        cypher = (
            f"MATCH (a:{source_label} {{title: $source_id}}), "
            f"(b:{target_label} {{title: $target_id}}) "
            f"MERGE (a)-[r:{rel_type}]->(b) "
        )
        if set_pairs:
            cypher += f"SET {set_pairs}"

        params = {"source_id": source_id, "target_id": target_id, **props}
        try:
            self.run(cypher, params)
            return True
        except Exception as e:
            sys.stderr.write(f"[neo4j] upsert_relationship failed: {e}\n")
            return False

    def find_paths(
        self,
        source_title: str,
        target_title: str,
        max_depth: int = 4,
        limit: int = 10,
    ) -> GraphQueryResult:
        cypher = (
            f"MATCH p = (a:WikiPage {{title: $source}})"
            f"-[*1..{max_depth}]-(b:WikiPage {{title: $target}}) "
            f"RETURN p LIMIT $limit"
        )
        return self.run_query(cypher, {"source": source_title, "target": target_title, "limit": limit})

    def get_neighbors(
        self,
        title: str,
        depth: int = 1,
        limit: int = 50,
    ) -> GraphQueryResult:
        cypher = (
            f"MATCH (a:WikiPage {{title: $title}})"
            f"-[r*1..{depth}]-(neighbor) "
            f"RETURN a, r, neighbor LIMIT $limit"
        )
        return self.run_query(cypher, {"title": title, "limit": limit})

    def search_nodes(
        self,
        keyword: str,
        labels: Optional[List[str]] = None,
        limit: int = 20,
    ) -> GraphQueryResult:
        label_filter = f":{':'.join(labels)}" if labels else ""
        cypher = (
            f"MATCH (n{label_filter}) "
            f"WHERE n.title CONTAINS $keyword OR n.content_preview CONTAINS $keyword "
            f"RETURN n LIMIT $limit"
        )
        return self.run_query(cypher, {"keyword": keyword, "limit": limit})

    def get_graph_stats(self) -> Dict[str, Any]:
        try:
            node_counts = self.run(
                "MATCH (n) RETURN labels(n) AS label, count(n) AS count"
            )
            rel_counts = self.run(
                "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count"
            )
            return {
                "node_counts": {r["label"][0]: r["count"] for r in node_counts},
                "relationship_counts": {r["type"]: r["count"] for r in rel_counts},
            }
        except Exception as e:
            sys.stderr.write(f"[neo4j] get_graph_stats failed: {e}\n")
            return {"node_counts": {}, "relationship_counts": {}}

    def community_detect(self, algorithm: str = "louvain") -> List[Dict[str, Any]]:
        try:
            self.run("CALL gds.graph.exists('wiki-graph') YIELD exists")
        except Exception:
            try:
                self.run(
                    "CALL gds.graph.project("
                    "'wiki-graph', 'WikiPage', "
                    "'LINKS_TO', {relationshipProperties: 'weight'})"
                )
            except Exception as e:
                sys.stderr.write(f"[neo4j] GDS project failed: {e}\n")
                return []

        algo_map = {
            "louvain": "CALL gds.louvain.stream('wiki-graph') YIELD nodeId, communityId RETURN gds.util.asNode(nodeId).title AS title, communityId ORDER BY communityId",
            "pagerank": "CALL gds.pageRank.stream('wiki-graph') YIELD nodeId, score RETURN gds.util.asNode(nodeId).title AS title, score ORDER BY score DESC",
            "betweenness": "CALL gds.betweenness.stream('wiki-graph') YIELD nodeId, score RETURN gds.util.asNode(nodeId).title AS title, score ORDER BY score DESC",
        }

        cypher = algo_map.get(algorithm, algo_map["louvain"])
        try:
            return self.run(cypher)
        except Exception as e:
            sys.stderr.write(f"[neo4j] GDS {algorithm} failed: {e}\n")
            return []

    def clear_project(self, project_name: str) -> bool:
        cypher = "MATCH (n:WikiPage {project: $project}) DETACH DELETE n"
        try:
            self.run(cypher, {"project": project_name})
            return True
        except Exception as e:
            sys.stderr.write(f"[neo4j] clear_project failed: {e}\n")
            return False


_client: Optional[Neo4jClient] = None


def get_neo4j_client() -> Optional[Neo4jClient]:
    global _client
    if _client is None:
        try:
            _client = Neo4jClient()
            if _client.available:
                sys.stderr.write(f"[neo4j] Connected to {_client.uri}\n")
            else:
                sys.stderr.write("[neo4j] Neo4j is not available, graph features disabled\n")
        except Exception as e:
            sys.stderr.write(f"[neo4j] Init failed: {e}\n")
            _client = Neo4jClient()
            return _client
    return _client
