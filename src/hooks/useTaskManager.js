import { useState, useCallback } from 'react';

let taskIdCounter = 0;

/**
 * 后台任务管理器 Hook
 * 用于管理下载、安装等耗时操作，支持在 UI 中显示任务进度
 */
export function useTaskManager() {
  const [tasks, setTasks] = useState([]);



  /**
   * 添加一个新任务
   * @param {string} name 任务名称
   * @param {number} [deadlineMs] 任务最大超时时间（毫秒），用于前端显示倒计时
   * @param {object} [metadata] 可选的元数据（如 chrys session 信息）
   * @returns {number} taskId
   */
  const addTask = useCallback((name, deadlineMs, metadata) => {
    const id = ++taskIdCounter;
    const task = {
      id,
      name,
      status: 'running',
      message: '',
      startTime: Date.now(),
      deadline: deadlineMs ? Date.now() + deadlineMs : undefined,
      progress: undefined,
      metadata: metadata || undefined,
    };
    setTasks(prev => [...prev, task]);
    return id;
  }, []);

  /**
   * 更新任务状态
   * @param {number} id
   * @param {object} updates - { status, message }
   */
  const updateTask = useCallback((id, updates) => {
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t;
      // 如果状态变为终态，自动记录完成时间
      const isTerminal = updates.status && updates.status !== 'running';
      const completedAt = isTerminal ? Date.now() : undefined;
      return { ...t, ...updates, ...(completedAt ? { completedAt } : {}) };
    }));
  }, []);

  /**
   * 执行一个后台任务
   * @param {string} name 任务显示名称
   * @param {Function} fn 要执行的异步函数，接收 updateMsg 回调参数
   *    fn 签名: async (updateMsg: (message: string) => void) => { success: boolean, message?: string }
   * @param {number} [deadlineMs] 任务最大超时时间（毫秒），用于前端显示倒计时
   * @param {object} [metadata] 可选的元数据
   * @returns {Promise<boolean>} 任务是否成功
   */
  const runTask = useCallback(async (name, fn, deadlineMs, metadata) => {
    const taskId = addTask(name, deadlineMs, metadata);
    try {
      const updateMsg = (message) => {
        updateTask(taskId, { message });
      };
      const result = await fn(updateMsg);
      if (result && result.success === false) {
        updateTask(taskId, { status: 'failed', message: result.message || '任务失败' });
        return false;
      }
      updateTask(taskId, { status: 'completed', message: result?.message || '完成' });
      return true;
    } catch (err) {
      updateTask(taskId, { status: 'failed', message: err.message || '未知错误' });
      return false;
    }
  }, [addTask, updateTask]);

  /**
   * 取消某个运行中的任务
   */
  const cancelTask = useCallback((taskId) => {
    updateTask(taskId, { status: 'cancelled', message: '已取消' });
  }, [updateTask]);

  /**
   * 更新任务进度（0-100）
   * @param {number} taskId
   * @param {number} progress 0-100
   */
  const updateProgress = useCallback((taskId, progress) => {
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;
      return { ...t, progress: Math.min(100, Math.max(0, progress)) };
    }));
  }, []);

  /**
   * 清除所有已终态的任务
   */
  const clearCompleted = useCallback(() => {
    setTasks(prev => prev.filter(t => t.status === 'running'));
  }, []);

  return {
    tasks,
    addTask,
    updateTask,
    runTask,
    cancelTask,
    clearCompleted,
    updateProgress,
  };
}

export default useTaskManager;
