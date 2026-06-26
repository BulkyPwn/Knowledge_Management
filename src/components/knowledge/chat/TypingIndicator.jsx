import React from 'react';
import { Bot } from 'lucide-react';

export default function TypingIndicator({ theme }) {
  return (
    <div className="flex justify-start">
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${theme === 'dark' ? 'bg-indigo-600' : theme === 'light' ? 'bg-indigo-500' : 'bg-indigo-600'}`}>
          <Bot className="w-4 h-4 text-white" />
        </div>
        <div className={`px-4 py-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-500'}`}>
          <div className="flex gap-1">
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
