import React from 'react';

// 向量可视化弹窗
export default function VectorModal({
  theme,
  vectorLoading, vectorError, vectorData,
  vectorCanvasRef, vectorTooltipRef,
  fetchVectorVisualization,
  onClose,
}) {
  // 计算页面颜色
  const pageColors = vectorData?.points
    ? (() => {
        const acc = {};
        vectorData.points.forEach(p => { acc[p.page_id] = true; });
        return Object.keys(acc);
      })()
    : [];

  const cp = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className={`w-[800px] max-h-[90vh] rounded-xl shadow-2xl overflow-hidden ${
        theme === 'dark' ? 'bg-gray-800 text-white' : theme === 'light' ? 'bg-white text-gray-900' : 'bg-gray-700 text-white'
      }`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-600">
          <h3 className="text-lg font-semibold">向量可视化</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <div className="p-6 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 70px)' }}>
          {vectorLoading && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mb-3"></div>
              <span className={theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}>正在加载向量数据...</span>
            </div>
          )}

          {vectorError && !vectorLoading && (
            <div className={`p-4 rounded-lg text-sm ${theme === 'dark' ? 'bg-red-900/30 text-red-300' : 'bg-red-50 text-red-600'}`}>
              {vectorError}
            </div>
          )}

          {vectorData && !vectorLoading && !vectorError && (
            <div>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className={`p-3 rounded-lg text-center ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className="text-2xl font-bold text-purple-500">{vectorData.total_vectors || 0}</div>
                  <div className="text-xs mt-1 opacity-60">加载向量数</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className="text-2xl font-bold text-indigo-500">{vectorData.dimension || 0}</div>
                  <div className="text-xs mt-1 opacity-60">向量维度</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className="text-2xl font-bold text-emerald-500">{new Set(vectorData.points.map(p => p.page_id)).size}</div>
                  <div className="text-xs mt-1 opacity-60">文档数</div>
                </div>
                <div className={`p-3 rounded-lg text-center ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-50'}`}>
                  <div className="text-2xl font-bold text-amber-500">{(vectorData.explained_variance_2d * 100).toFixed(1)}%</div>
                  <div className="text-xs mt-1 opacity-60">2D 解释方差</div>
                </div>
              </div>

              {pageColors.length > 1 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {pageColors.map((pageId) => {
                    const count = vectorData.points.filter(p => p.page_id === pageId).length;
                    const idx = pageColors.indexOf(pageId);
                    return (
                      <span key={pageId} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs" style={{ backgroundColor: cp[idx % cp.length] + '20', color: cp[idx % cp.length] }}>
                        <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: cp[idx % cp.length] }}></span>
                        {pageId} ({count})
                      </span>
                    );
                  })}
                </div>
              )}

              <div className={`rounded-lg border ${theme === 'dark' ? 'border-gray-600' : 'border-gray-200'}`} style={{ position: 'relative' }}>
                <canvas
                  ref={vectorCanvasRef}
                  style={{ width: '100%', height: '400px', cursor: 'crosshair', display: 'block' }}
                  onMouseMove={(e) => {
                    const canvas = vectorCanvasRef.current;
                    if (!canvas || !canvas._points) return;
                    const canvasRect = canvas.getBoundingClientRect();
                    const mouseX = e.clientX - canvasRect.left;
                    const mouseY = e.clientY - canvasRect.top;

                    let nearest = null, nearestDist = 40;
                    canvas._points.forEach((p) => {
                      const cx = canvas._scaleX(p.x);
                      const cy = canvas._scaleY(p.y);
                      const d = Math.sqrt((mouseX - cx) ** 2 + (mouseY - cy) ** 2);
                      if (d < nearestDist) { nearestDist = d; nearest = { ...p, cx, cy }; }
                    });

                    const tooltip = vectorTooltipRef.current;
                    if (nearest && tooltip) {
                      tooltip.style.display = 'block';
                      tooltip.style.left = (nearest.cx + 12) + 'px';
                      tooltip.style.top = (nearest.cy - 10) + 'px';
                      tooltip.innerHTML = `<b>${nearest.page_id}</b>${nearest.heading_path ? '<br/>' + nearest.heading_path : ''}${nearest.chunk_text ? '<br/><span style="opacity:0.7;font-size:11px">' + nearest.chunk_text + '</span>' : ''}`;
                    } else if (tooltip) {
                      tooltip.style.display = 'none';
                    }
                  }}
                  onMouseLeave={() => {
                    if (vectorTooltipRef.current) vectorTooltipRef.current.style.display = 'none';
                  }}
                />
                <div
                  ref={vectorTooltipRef}
                  style={{
                    display: 'none',
                    position: 'absolute',
                    pointerEvents: 'none',
                    zIndex: 10,
                    padding: '6px 10px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    backgroundColor: theme === 'dark' ? '#374151' : '#1f2937',
                    color: '#f9fafb',
                    maxWidth: '320px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                    whiteSpace: 'normal',
                    wordBreak: 'break-all',
                  }}
                ></div>
              </div>

              <div className="mt-3 flex justify-between items-center">
                <span className={`text-xs ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                  表: {vectorData.table} | 每点代表一个文本分块 | 悬停查看详情
                </span>
                <button
                  onClick={fetchVectorVisualization}
                  disabled={vectorLoading}
                  className={`px-3 py-1 rounded text-xs text-white transition-all ${
                    vectorLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'
                  }`}
                >
                  刷新
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
