from typing import List, Dict, Any, Optional
from dataclasses import dataclass

@dataclass
class TreeNode:
    node_id: str
    content: str
    embedding: Optional[List[float]] = None
    children: List['TreeNode'] = None
    parent: Optional['TreeNode'] = None
    level: int = 0
    score: float = 0.0
    metadata: Dict[str, Any] = None
    
    def __post_init__(self):
        if self.children is None:
            self.children = []
        if self.metadata is None:
            self.metadata = {}
    
    def add_child(self, child: 'TreeNode'):
        child.parent = self
        child.level = self.level + 1
        self.children.append(child)
    
    def get_descendants(self) -> List['TreeNode']:
        descendants = []
        stack = [self]
        while stack:
            node = stack.pop()
            for child in node.children:
                descendants.append(child)
                stack.append(child)
        return descendants
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'node_id': self.node_id,
            'content': self.content,
            'level': self.level,
            'score': self.score,
            'metadata': self.metadata,
            'children': [child.to_dict() for child in self.children]
        }

class TreeStructure:
    def __init__(self):
        self.root: Optional[TreeNode] = None
        self.nodes: Dict[str, TreeNode] = {}
    
    def add_node(self, node: TreeNode, parent_id: Optional[str] = None):
        self.nodes[node.node_id] = node
        
        if parent_id is None:
            if self.root is None:
                self.root = node
        else:
            if parent_id in self.nodes:
                parent_node = self.nodes[parent_id]
                parent_node.add_child(node)
    
    def get_node(self, node_id: str) -> Optional[TreeNode]:
        return self.nodes.get(node_id)
    
    def get_leaves(self) -> List[TreeNode]:
        leaves = []
        if self.root is None:
            return leaves
        
        stack = [self.root]
        while stack:
            node = stack.pop()
            if not node.children:
                leaves.append(node)
            else:
                stack.extend(node.children)
        return leaves
    
    def get_nodes_by_level(self, level: int) -> List[TreeNode]:
        nodes = []
        if self.root is None:
            return nodes
        
        stack = [self.root]
        while stack:
            node = stack.pop()
            if node.level == level:
                nodes.append(node)
            stack.extend(node.children)
        return nodes
    
    def to_dict(self) -> Dict[str, Any]:
        if self.root is None:
            return {'nodes': [], 'root': None}
        return {
            'nodes': [node.to_dict() for node in self.nodes.values()],
            'root': self.root.node_id if self.root else None
        }
