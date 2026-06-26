# 知识管理后端服务

基于Flask实现的知识管理后端服务，提供RESTful API接口。

## 安装依赖

```bash
pip install -r requirements.txt
```

## 启动服务

```bash
python app.py
```

服务将在 `http://localhost:5000` 启动。

## API接口

### 1. 获取所有知识条目
- **GET** `/api/knowledge`

### 2. 获取单个知识条目
- **GET** `/api/knowledge/{id}`

### 3. 创建知识条目
- **POST** `/api/knowledge`
- 请求体：
```json
{
    "title": "标题",
    "content": "内容",
    "category": "分类",
    "tags": ["标签1", "标签2"],
    "created_at": "2024-01-01 12:00:00",
    "updated_at": "2024-01-01 12:00:00"
}
```

### 4. 更新知识条目
- **PUT** `/api/knowledge/{id}`
- 请求体：同上（可选字段）

### 5. 删除知识条目
- **DELETE** `/api/knowledge/{id}`

### 6. 获取所有分类
- **GET** `/api/knowledge/categories`

### 7. 搜索知识条目
- **GET** `/api/knowledge/search?q=关键词&category=分类`

## 数据存储

知识数据存储在 `knowledge_base.json` 文件中。
