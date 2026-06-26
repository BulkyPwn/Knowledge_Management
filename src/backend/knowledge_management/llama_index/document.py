from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class Document:
    id: str
    text: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[List[float]] = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'text': self.text,
            'text_preview': self.text[:200] + '...' if len(self.text) > 200 else self.text,
            'metadata': self.metadata,
            'created_at': self.created_at
        }

@dataclass
class Node:
    id: str
    text: str
    index: int
    document_id: str
    parent_id: Optional[str] = None
    children_ids: List[str] = field(default_factory=list)
    embedding: Optional[List[float]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id,
            'text': self.text,
            'text_preview': self.text[:200] + '...' if len(self.text) > 200 else self.text,
            'index': self.index,
            'document_id': self.document_id,
            'parent_id': self.parent_id,
            'children_ids': self.children_ids,
            'metadata': self.metadata
        }

class NodeBuilder:
    @staticmethod
    def build_nodes_from_document(doc: Document, chunk_size: int = 500, overlap: int = 50) -> List[Node]:
        nodes = []
        text = doc.text
        doc_id = doc.id
        
        for i in range(0, len(text), chunk_size - overlap):
            if i >= len(text):
                break
            
            chunk_text = text[i:i + chunk_size]
            node_id = f"{doc_id}_node_{len(nodes)}"
            
            node = Node(
                id=node_id,
                text=chunk_text,
                index=len(nodes),
                document_id=doc_id,
                metadata={
                    'chunk_start': i,
                    'chunk_end': min(i + chunk_size, len(text))
                }
            )
            nodes.append(node)
        
        return nodes
    
    @staticmethod
    def build_summary_node(nodes: List[Node], level: int = 0) -> Node:
        combined_text = "\n\n".join([n.text for n in nodes])
        
        summary_text = combined_text[:300] + "..." if len(combined_text) > 300 else combined_text
        
        return Node(
            id=f"summary_level_{level}",
            text=summary_text,
            index=0,
            document_id="summary",
            metadata={'level': level, 'child_count': len(nodes)}
        )
