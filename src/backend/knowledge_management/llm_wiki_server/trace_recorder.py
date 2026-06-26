"""
Fusion Search Trace 记录器
=========================
内存 ringbuffer，供 agent_tools.py 写入、app.py 读取。
避免循环导入。
"""

from datetime import datetime

_traces = []
_TRACE_MAX = 100


def record(event_type: str, data: dict, level: str = "info"):
    """写入一条 trace 记录"""
    global _traces
    _traces.append({
        "timestamp": datetime.now().isoformat(),
        "type": event_type,
        "level": level,
        "data": data,
    })
    if len(_traces) > _TRACE_MAX:
        _traces = _traces[-_TRACE_MAX:]


def get_recent(limit: int = 20) -> list:
    """读取最近 N 条记录"""
    return _traces[-limit:] if _traces else []


def get_all() -> list:
    """读取所有记录"""
    return list(_traces)


def clear():
    """清空所有记录"""
    global _traces
    count = len(_traces)
    _traces = []
    return count


def count() -> int:
    """当前记录数"""
    return len(_traces)


def max_capacity() -> int:
    """最大容量"""
    return _TRACE_MAX
