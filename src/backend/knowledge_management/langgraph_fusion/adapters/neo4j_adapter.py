"""
Neo4j 知识图谱适配器
====================
将内存 KnowledgeGraph 同步到 Neo4j，支持图检索、子图遍历、多跳路径查询。

用法:
    adapter = Neo4jAdapter(uri="bolt://localhost:7687", user="neo4j", password="xxx")
    adapter.sync_from_memory_graph(kg)  # 同步内存图到 Neo4j
    subgraph = adapter.search_subgraph(entity_ids=["id1", "id2"])
    paths = adapter.multi_hop_query("Entity A", "Entity B", max_hops=3)
"""

import sys
import os
import logging
from typing import List, Optional, Dict, Any

_logger = logging.getLogger("langgraph_fusion.neo4j")

# 确保父目录在 sys.path 中，以便导入 graph_rag
_parent_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _parent_dir not in sys.path:
    sys.path.insert(0, _parent_dir)

try:
    from neo4j import GraphDatabase, Driver
except ImportError:
    GraphDatabase = None
    Driver = None

try:
    from graph_rag.graph import KnowledgeGraph, Entity, Relation
except ImportError:
    KnowledgeGraph = None
    Entity = None
    Relation = None


class Neo4jAdapter:
    """
    Neo4j 图数据库适配器。

    提供核心能力：
    - 从内存 KnowledgeGraph 同步到 Neo4j
    - 子图检索（以实体为中心，depth 跳邻居）
    - 多跳路径查询（最短路径）
    - 实体名模糊匹配
    """

    def __init__(self, uri: str = "bolt://localhost:7687", user: str = "neo4j", password: str = "password"):
        """
        Args:
            uri: Neo4j Bolt URI
            user: 用户名
            password: 密码
        """
        self._uri = uri
        self._user = user
        self._password = password
        self._driver: Optional[Driver] = None

    @property
    def driver(self) -> Driver:
        """延迟创建驱动连接"""
        if self._driver is None:
            if GraphDatabase is None:
                raise ImportError("neo4j package is not installed. Run: pip install neo4j")
            self._driver = GraphDatabase.driver(self._uri, auth=(self._user, self._password))
        return self._driver

    def close(self):
        """关闭连接"""
        if self._driver:
            self._driver.close()
            self._driver = None

    def is_connected(self) -> bool:
        """测试连接是否可用"""
        try:
            with self.driver.session() as session:
                result = session.run("RETURN 1 AS n")
                record = result.single()
                ok = record is not None and record["n"] == 1
                _logger.info(f"Neo4j connection test: {'OK' if ok else 'FAILED'}")
                return ok
        except Exception as e:
            _logger.warning(f"Neo4j connection failed: {e}")
            return False

    # ── 数据同步 ──────────────────────────────────────────────

    def sync_from_memory_graph(self, kg, clear_first: bool = True):
        """
        将内存 KnowledgeGraph 全量同步到 Neo4j。

        Args:
            kg: graph_rag.graph.KnowledgeGraph 实例
            clear_first: 是否先清空 Neo4j 中的所有数据
        """
        with self.driver.session() as session:
            if clear_first:
                session.run("MATCH (n) DETACH DELETE n")
                _logger.debug("Cleared all Neo4j data")

            entity_count = len(kg.entities)
            relation_count = len(kg.relations)
            _logger.info(f"Syncing to Neo4j: {entity_count} entities, {relation_count} relations")

            # 批量创建实体
            for e in kg.entities.values():
                session.run(
                    """
                    MERGE (n:Entity {id: $id})
                    SET n.name = $name,
                        n.type = $type,
                        n.description = $desc,
                        n.properties = $props
                    """,
                    id=e.id,
                    name=e.name,
                    type=e.entity_type,
                    desc=e.description,
                    props=e.properties,
                )

            # 批量创建关系
            for r in kg.relations.values():
                session.run(
                    """
                    MATCH (a:Entity {id: $sid})
                    MATCH (b:Entity {id: $tid})
                    MERGE (a)-[rel:RELATES {id: $rid}]->(b)
                    SET rel.type = $rtype,
                        rel.weight = $weight
                    """,
                    sid=r.source_id,
                    tid=r.target_id,
                    rid=r.id,
                    rtype=r.relation_type,
                    weight=r.weight,
                )

            _logger.info(f"Neo4j sync complete: {entity_count} entities, {relation_count} relations")

    def upsert_entity(self, entity_id: str, name: str, entity_type: str,
                      description: str = "", properties: dict = None):
        """插入或更新单个实体"""
        with self.driver.session() as session:
            session.run(
                """
                MERGE (n:Entity {id: $id})
                SET n.name = $name,
                    n.type = $type,
                    n.description = $desc,
                    n.properties = $props
                """,
                id=entity_id, name=name, type=entity_type,
                desc=description, props=properties or {},
            )

    def upsert_relation(self, relation_id: str, source_id: str, target_id: str,
                        relation_type: str, weight: float = 1.0):
        """插入或更新单个关系"""
        with self.driver.session() as session:
            session.run(
                """
                MATCH (a:Entity {id: $sid})
                MATCH (b:Entity {id: $tid})
                MERGE (a)-[rel:RELATES {id: $rid}]->(b)
                SET rel.type = $rtype,
                    rel.weight = $weight
                """,
                sid=source_id, tid=target_id, rid=relation_id,
                rtype=relation_type, weight=weight,
            )

    def delete_entity_cascade(self, entity_id: str):
        """删除实体及其关联关系"""
        with self.driver.session() as session:
            session.run(
                "MATCH (n:Entity {id: $id}) DETACH DELETE n",
                id=entity_id,
            )

    # ── 检索查询 ──────────────────────────────────────────────

    def match_entities(self, names: List[str]) -> List[Dict[str, Any]]:
        """按实体名模糊匹配（CONTAINS 不区分大小写）"""
        if not names:
            _logger.debug("match_entities: empty names list")
            return []

        with self.driver.session() as session:
            conditions = " OR ".join(["n.name CONTAINS $name_" + str(i) for i in range(len(names))])
            if not conditions:
                return []

            params = {f"name_{i}": name for i, name in enumerate(names)}
            result = session.run(
                f"MATCH (n:Entity) WHERE {conditions} RETURN n LIMIT 50",
                **params,
            )
            matched = [dict(record["n"]) for record in result]
            _logger.info(f"match_entities: {len(names)} names -> {len(matched)} matched")
            return matched

    def search_subgraph(self, entity_ids: List[str], depth: int = 2) -> dict:
        """
        检索以指定实体为起点的子图。

        Args:
            entity_ids: 实体 ID 列表
            depth: 邻居跳数

        Returns:
            {"entities": [...], "relations": [...]}
        """
        if not entity_ids:
            return {"entities": [], "relations": []}

        with self.driver.session() as session:
            result = session.run(
                """
                MATCH (e:Entity)
                WHERE e.id IN $ids
                OPTIONAL MATCH (e)-[r:RELATES*1..$depth]-(neighbor:Entity)
                RETURN e, r, neighbor
                LIMIT 200
                """,
                ids=entity_ids, depth=depth,
            )

            entities = {}
            relations = {}
            for record in result:
                e = record["e"]
                entities[e["id"]] = dict(e)
                if record.get("neighbor"):
                    neighbor = record["neighbor"]
                    entities[neighbor["id"]] = dict(neighbor)
                if record.get("r"):
                    for rel in record["r"]:
                        relations[rel["id"]] = dict(rel)

            return {
                "entities": list(entities.values()),
                "relations": list(relations.values()),
            }

    def multi_hop_query(self, source_name: str, target_name: str,
                        max_hops: int = 3) -> List[dict]:
        """
        多跳路径查询：找两个实体之间的最短路径。

        Args:
            source_name: 起点实体名
            target_name: 终点实体名
            max_hops: 最大跳数

        Returns:
            路径列表
        """
        with self.driver.session() as session:
            result = session.run(
                """
                MATCH path = shortestPath(
                    (a:Entity {name: $sname})-[*1..$hops]-(b:Entity {name: $tname})
                )
                RETURN path
                """,
                sname=source_name, tname=target_name, hops=max_hops,
            )
            paths = []
            for record in result:
                path = record["path"]
                nodes = [dict(node) for node in path.nodes]
                rels = [dict(rel) for rel in path.relationships]
                paths.append({"nodes": nodes, "relations": rels})
            return paths

    def get_entity_neighbors(self, entity_id: str) -> Dict[str, Any]:
        """
        获取实体的直接邻居。

        Returns:
            {"entity": {...}, "neighbors": [...], "relations": [...]}
        """
        with self.driver.session() as session:
            result = session.run(
                """
                MATCH (e:Entity {id: $id})
                OPTIONAL MATCH (e)-[r:RELATES]-(n:Entity)
                RETURN e, collect(DISTINCT r) AS rels, collect(DISTINCT n) AS neighbors
                """,
                id=entity_id,
            )
            record = result.single()
            if not record:
                return {"entity": None, "neighbors": [], "relations": []}

            return {
                "entity": dict(record["e"]),
                "neighbors": [dict(n) for n in (record["neighbors"] or [])],
                "relations": [dict(r) for r in (record["rels"] or [])],
            }

    def get_graph_stats(self) -> Dict[str, Any]:
        """获取图谱统计信息"""
        with self.driver.session() as session:
            entity_count = session.run(
                "MATCH (n:Entity) RETURN count(n) AS cnt"
            ).single()["cnt"]
            relation_count = session.run(
                "MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt"
            ).single()["cnt"]
            types = session.run(
                "MATCH (n:Entity) RETURN DISTINCT n.type AS type"
            ).values()
            rel_types = session.run(
                "MATCH ()-[r:RELATES]->() RETURN DISTINCT r.type AS type"
            ).values()

            return {
                "entity_count": entity_count,
                "relation_count": relation_count,
                "entity_types": [t[0] for t in types],
                "relation_types": [t[0] for t in rel_types],
            }
