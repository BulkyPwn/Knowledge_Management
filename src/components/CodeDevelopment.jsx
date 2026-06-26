import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Plus, X, Send, ChevronDown, ChevronRight, Folder, FileCode, FolderOpen, Eye, Terminal, Command, Bug, GitBranch, CheckCircle, AlertCircle, XCircle, Clock, Zap, Search, ArrowUpDown, FileText } from 'lucide-react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { Terminal as XTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

loader.config({ monaco });

function CodeDevelopment({ theme, tabs, setTabs, activeTab, setActiveTab, tabStates, setTabStates }) {
  const [splitRatio, setSplitRatio] = useState(35);
  const [isDragging, setIsDragging] = useState(false);
  const [editorSplitRatio, setEditorSplitRatio] = useState(70);
  const [isEditorDragging, setIsEditorDragging] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandInput, setCommandInput] = useState('');
  const [showProblems, setShowProblems] = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [statusBarItems, setStatusBarItems] = useState({
    branch: 'main',
    language: 'JavaScript',
    line: 1,
    col: 1,
    encoding: 'UTF-8',
    indentation: 'Spaces: 2'
  });
  
  const editorRef = useRef(null);
  const chatEndRef = useRef(null);
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);

  const messages = useMemo(() => tabStates[activeTab]?.messages || [], [tabStates, activeTab]);
  const fileContent = useMemo(() => tabStates[activeTab]?.fileContent || '', [tabStates, activeTab]);
  const currentPath = useMemo(() => tabStates[activeTab]?.currentPath || '', [tabStates, activeTab]);
  const fileTree = useMemo(() => tabStates[activeTab]?.fileTree || [], [tabStates, activeTab]);
  
  const setMessages = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], messages: value }
    }));
  };
  
  const setFileContent = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], fileContent: value }
    }));
  };
  
  const setCurrentPath = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], currentPath: value }
    }));
  };
  
  const setFileTree = (value) => {
    setTabStates(prev => ({
      ...prev,
      [activeTab]: { ...prev[activeTab], fileTree: value }
    }));
  };

  const [parentPath, setParentPath] = useState(null);
  const [currentFileLanguage, setCurrentFileLanguage] = useState('javascript');
  const [showBrowseModal, setShowBrowseModal] = useState(false);
  const [problems, setProblems] = useState([
    { type: 'error', message: 'Undefined variable: x', file: 'app.js', line: 15 },
    { type: 'warning', message: 'Unused variable: temp', file: 'utils.js', line: 8 },
    { type: 'info', message: 'File has trailing whitespace', file: 'config.js', line: 22 }
  ]);
  const [outputLines, setOutputLines] = useState(['> Running build...', '> Compilation successful']);

  const defaultFileTree = [
    { type: 'directory', name: 'src', path: '/src' },
    { type: 'directory', name: 'components', path: '/components' },
    { type: 'file', name: 'App.js', path: '/App.js', size: 2048 },
    { type: 'file', name: 'index.js', path: '/index.js', size: 1024 },
    { type: 'file', name: 'package.json', path: '/package.json', size: 512 },
    { type: 'file', name: 'README.md', path: '/README.md', size: 1536 }
  ];

  const defaultFileContent = `// Welcome to Code Development
// This is a sample JavaScript file

function greet(name) {
  return \`Hello, \${name}!\`;
}

const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(n => n * 2);

console.log(greet('World'));
console.log('Doubled numbers:', doubled);

// Example class
class Calculator {
  constructor() {
    this.result = 0;
  }

  add(a, b) {
    this.result = a + b;
    return this;
  }

  subtract(a, b) {
    this.result = a - b;
    return this;
  }

  getResult() {
    return this.result;
  }
}

const calc = new Calculator();
console.log(calc.add(5, 3).getResult());

// Async function example
async function fetchData(url) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}

// Export for use in other files
export { greet, Calculator, fetchData };
`;

  useEffect(() => {
    loadRootFiles();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      const container = document.querySelector('.code-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(Math.max(newRatio, 20), 80));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const container = document.querySelector('.code-container');
    if (container) {
      container.addEventListener('mousemove', handleMouseMove);
      container.addEventListener('mouseup', handleMouseUp);
      container.addEventListener('mouseleave', handleMouseUp);
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('mouseup', handleMouseUp);
        container.removeEventListener('mouseleave', handleMouseUp);
      }
    };
  }, [isDragging]);

  useEffect(() => {
    const handleEditorMouseMove = (e) => {
      if (!isEditorDragging) return;
      const container = document.querySelector('.editor-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
      setEditorSplitRatio(Math.min(Math.max(newRatio, 30), 80));
    };

    const handleEditorMouseUp = () => {
      setIsEditorDragging(false);
    };

    const container = document.querySelector('.editor-container');
    if (container) {
      container.addEventListener('mousemove', handleEditorMouseMove);
      container.addEventListener('mouseup', handleEditorMouseUp);
      container.addEventListener('mouseleave', handleEditorMouseUp);
    }

    return () => {
      if (container) {
        container.removeEventListener('mousemove', handleEditorMouseMove);
        container.removeEventListener('mouseup', handleEditorMouseUp);
        container.removeEventListener('mouseleave', handleEditorMouseUp);
      }
    };
  }, [isEditorDragging]);

  useEffect(() => {
    if (terminalRef.current && !xtermRef.current) {
      const terminal = new XTerminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
        theme: theme === 'dark' ? {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#aeafad',
          selection: '#264f78',
          black: '#000000',
          red: '#f14c4c',
          green: '#6a9955',
          yellow: '#dcdcaa',
          blue: '#569cd6',
          magenta: '#c586c0',
          cyan: '#4ec9b0',
          white: '#d4d4d4',
          brightBlack: '#666666',
          brightRed: '#f14c4c',
          brightGreen: '#6a9955',
          brightYellow: '#dcdcaa',
          brightBlue: '#569cd6',
          brightMagenta: '#c586c0',
          brightCyan: '#4ec9b0',
          brightWhite: '#ffffff'
        } : {
          background: '#ffffff',
          foreground: '#373737',
          cursor: '#000000',
          selection: '#add6ff',
          black: '#000000',
          red: '#ff0000',
          green: '#008000',
          yellow: '#808000',
          blue: '#0000ff',
          magenta: '#800080',
          cyan: '#008080',
          white: '#c0c0c0',
          brightBlack: '#808080',
          brightRed: '#ff0000',
          brightGreen: '#00ff00',
          brightYellow: '#ffff00',
          brightBlue: '#0000ff',
          brightMagenta: '#ff00ff',
          brightCyan: '#00ffff',
          brightWhite: '#ffffff'
        }
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalRef.current);
      fitAddon.fit();

      terminal.write('Welcome to Code Development Terminal\n');
      terminal.write('$ ');

      terminal.onData((data) => {
        if (data === '\r') {
          terminal.write('\n$ ');
        } else if (data === '\x7f') {
          terminal.write('\b \b');
        } else {
          terminal.write(data);
        }
      });

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      return () => {
        terminal.dispose();
      };
    }
  }, [terminalOpen, theme]);

  useEffect(() => {
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
    }
  }, [terminalOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '`') {
        e.preventDefault();
        setTerminalOpen(prev => !prev);
      }
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const loadRootFiles = async () => {
    try {
      const response = await fetch('http://127.0.0.1:5000/api/filesystem/root');
      const data = await response.json();
      if (data.success) {
        setFileTree(data.data);
        setCurrentPath('');
        setParentPath(null);
      }
    } catch (error) {
      console.log('Using default file tree (backend not available)');
      setFileTree(defaultFileTree);
      setCurrentPath('');
      setParentPath(null);
      setFileContent(defaultFileContent);
      setCurrentFileLanguage('javascript');
      setStatusBarItems(prev => ({ ...prev, language: 'JAVASCRIPT' }));
    }
  };

  const loadDirectory = async (path) => {
    try {
      const response = await fetch(`http://127.0.0.1:5000/api/filesystem/list?path=${encodeURIComponent(path)}`);
      const data = await response.json();
      if (data.success) {
        setFileTree(data.data.items);
        setCurrentPath(data.data.current_path);
        setParentPath(data.data.parent_path);
      }
    } catch (error) {
      console.log('Using default directory (backend not available)');
      setFileTree(defaultFileTree);
      setCurrentPath(path);
      setParentPath('');
    }
  };

  const readFile = async (path) => {
    try {
      const response = await fetch(`http://127.0.0.1:5000/api/filesystem/read?path=${encodeURIComponent(path)}`);
      const data = await response.json();
      if (data.success) {
        setFileContent(data.data.content);
        const filename = path.split('/').pop();
        setCurrentFileLanguage(getLanguageFromExtension(filename));
        setStatusBarItems(prev => ({ ...prev, language: getLanguageFromExtension(filename).toUpperCase() }));
      }
    } catch (error) {
      console.log('Using default file content (backend not available)');
      const filename = path.split('/').pop();
      setCurrentFileLanguage(getLanguageFromExtension(filename));
      setStatusBarItems(prev => ({ ...prev, language: getLanguageFromExtension(filename).toUpperCase() }));
      
      const sampleContents = {
        'App.js': defaultFileContent,
        'index.js': `import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);`,
        'package.json': `{
  "name": "my-app",
  "version": "1.0.0",
  "description": "A sample React application",
  "main": "index.js",
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}`,
        'README.md': `# My Application

## Description
This is a sample React application demonstrating the Code Development features.

## Features
- Code editing with syntax highlighting
- File explorer
- Integrated terminal
- Command palette
- Problems panel
- Output panel

## Getting Started
\`\`\`bash
npm install
npm start
\`\`\`

## Usage
1. Open the Code Development page
2. Browse files in the explorer
3. Edit code in the editor
4. Use the terminal for commands
5. Press Ctrl+P for command palette

## Keyboard Shortcuts
- \`Ctrl+P\` - Open command palette
- \`Ctrl+Shift+\`\` - Toggle terminal
- \`Ctrl+Shift+M\` - Toggle problems panel
- \`ESC\` - Close dialogs
`
      };
      
      setFileContent(sampleContents[filename] || `// File: ${filename}\n// This is a sample file\n\n// Add your code here\n`);
    }
  };

  const navigateUp = () => {
    if (parentPath) {
      loadDirectory(parentPath);
    } else {
      loadRootFiles();
    }
  };

  const handleBrowseClick = () => {
    setShowBrowseModal(true);
  };

  const handleSelectWorkspace = () => {
    if (currentPath) {
      loadDirectory(currentPath);
      setShowBrowseModal(false);
    }
  };

  const addTab = () => {
    const newId = tabs.length + 1;
    setTabs([...tabs, { id: newId, name: `Code Page ${newId}` }]);
    setActiveTab(newId);
    setTabStates(prev => ({
      ...prev,
      [newId]: {
        messages: [],
        fileContent: '',
        currentPath: '',
        fileTree: []
      }
    }));
  };

  const closeTab = (id) => {
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTab === id) {
      setActiveTab(newTabs[0]?.id || 1);
    }
  };

  const getLanguageFromExtension = (filename) => {
    const ext = filename.split('.').pop().toLowerCase();
    const languageMap = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'php': 'php',
      'rb': 'ruby',
      'swift': 'swift',
      'kotlin': 'kotlin',
      'sql': 'sql',
      'md': 'markdown',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'sh': 'shell',
      'bash': 'shell',
      'dockerfile': 'dockerfile',
      'txt': 'plaintext',
    };
    return languageMap[ext] || 'plaintext';
  };

  const handleItemClick = (item) => {
    if (item.type === 'directory' || item.type === 'drive') {
      loadDirectory(item.path);
    } else if (item.type === 'file') {
      setCurrentFileLanguage(getLanguageFromExtension(item.name));
      readFile(item.path);
    }
  };

  const sendMessage = () => {
    if (!inputValue.trim()) return;
    const newMessages = [...messages, { type: 'user', content: inputValue }];
    setMessages(newMessages);
    setInputValue('');
    
    setTimeout(() => {
      const updatedMessages = [...newMessages, { type: 'assistant', content: 'This is the code development assistant response to help analyze code structure and optimization suggestions...' }];
      setMessages(updatedMessages);
    }, 1000);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const renderFileTree = (items) => {
    return items.map((item, index) => (
      <div key={`${item.path}-${index}`}>
        <div 
          onClick={() => handleItemClick(item)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-all ${
            theme === 'dark' ? 'text-gray-400 hover:bg-gray-700' : theme === 'light' ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-500'
          }`}
          title={item.path}
        >
          {(item.type === 'directory' || item.type === 'drive') ? (
            <>
              <ChevronRight className="w-3 h-3" />
              <Folder className="w-4 h-4" />
            </>
          ) : (
            <>
              <span className="w-3" />
              <FileCode className="w-4 h-4" />
            </>
          )}
          <span className="text-sm truncate flex-1">{item.name}</span>
          {item.type === 'file' && item.size && (
            <span className={`text-xs ${theme === 'dark' ? 'text-gray-600' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
              {(item.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>
      </div>
    ));
  };

  const commands = [
    { name: 'New File', icon: FileText, shortcut: 'Ctrl+N', action: () => {} },
    { name: 'Open File', icon: FolderOpen, shortcut: 'Ctrl+O', action: () => setShowBrowseModal(true) },
    { name: 'Save', icon: CheckCircle, shortcut: 'Ctrl+S', action: () => {} },
    { name: 'Terminal: Toggle', icon: Terminal, shortcut: 'Ctrl+Shift+`', action: () => setTerminalOpen(prev => !prev) },
    { name: 'Problems: Toggle', icon: Bug, shortcut: 'Ctrl+Shift+M', action: () => setShowProblems(prev => !prev) },
    { name: 'Command Palette', icon: Command, shortcut: 'Ctrl+Shift+P', action: () => {} },
    { name: 'Search', icon: Search, shortcut: 'Ctrl+F', action: () => {} },
    { name: 'Run Build', icon: Zap, shortcut: 'Ctrl+Shift+B', action: () => {} },
  ];

  const filteredCommands = commands.filter(cmd => 
    cmd.name.toLowerCase().includes(commandInput.toLowerCase())
  );

  const errorCount = problems.filter(p => p.type === 'error').length;
  const warningCount = problems.filter(p => p.type === 'warning').length;

  return (
    <div className="h-full flex flex-col">
      <div className={`flex items-center gap-1 px-2 py-2 ${theme === 'dark' ? 'bg-gray-800 border-b border-gray-700' : theme === 'light' ? 'bg-white border-b border-gray-200' : 'bg-gray-600 border-b border-gray-500'}`}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex items-center gap-2 px-4 py-2 rounded-t-lg cursor-pointer transition-all ${
              activeTab === tab.id
                ? `${theme === 'dark' ? 'bg-gray-700 text-white' : theme === 'light' ? 'bg-gray-100 text-gray-900' : 'bg-gray-500 text-white'}`
                : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-300 hover:text-white'}`
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="text-sm">{tab.name}</span>
            <button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} className="hover:text-red-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button onClick={addTab} className={`ml-auto p-2 rounded-lg transition-all ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' : 'text-gray-300 hover:bg-gray-500 hover:text-white'}`}>
          <Plus className="w-5 h-5" />
        </button>
        
        <div className={`flex items-center gap-1 ml-2 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
          <button 
            onClick={() => setCommandPaletteOpen(true)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-opacity-20 transition-all ${theme === 'dark' ? 'hover:bg-gray-700' : theme === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-500'}`}
          >
            <Command className="w-3 h-3" />
            <span>Ctrl+P</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden code-container">
        <div style={{ width: `${splitRatio}%` }} className={`flex flex-col overflow-hidden ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`}>
          <div className={`flex-1 overflow-auto p-4 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
            <div className="space-y-4">
              {messages?.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-4 py-3 ${msg.type === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
                    <p className="text-sm">{msg.content}</p>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>
          
          <div className={`p-4 border-t ${theme === 'dark' ? 'border-gray-700 bg-gray-800' : theme === 'light' ? 'border-gray-200 bg-white' : 'border-gray-500 bg-gray-600'}`}>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Enter code related questions..."
                className={`flex-1 px-4 py-2 rounded-lg outline-none transition-all ${
                  theme === 'dark' 
                    ? 'bg-gray-700 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500' 
                    : theme === 'light' 
                      ? 'bg-gray-100 text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-indigo-500' 
                      : 'bg-gray-500 text-white placeholder-gray-400 focus:ring-2 focus:ring-indigo-500'
                }`}
              />
              <button
                onClick={sendMessage}
                className={`px-4 py-2 rounded-lg transition-all ${theme === 'dark' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : theme === 'light' ? 'bg-indigo-500 hover:bg-indigo-600 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        <div 
          className={`w-1 h-full cursor-col-resize flex items-center justify-center transition-colors ${
            isDragging 
              ? `${theme === 'dark' ? 'bg-indigo-500' : theme === 'light' ? 'bg-indigo-400' : 'bg-indigo-500'}` 
              : `${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400' : 'bg-gray-400 hover:bg-gray-300'}`
          }`}
          onMouseDown={() => setIsDragging(true)}
        >
          <div className={`w-0.5 h-8 rounded-full ${theme === 'dark' ? 'bg-gray-400' : theme === 'light' ? 'bg-gray-500' : 'bg-gray-300'}`} />
        </div>

        <div style={{ width: `${100 - splitRatio}%` }} className="flex flex-col">
          <div className={`flex items-center gap-2 px-3 py-2 border-b ${theme === 'dark' ? 'bg-gray-800 border-gray-700' : theme === 'light' ? 'bg-white border-gray-200' : 'bg-gray-600 border-gray-500'}`}>
            <button
              onClick={handleBrowseClick}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all ${
                theme === 'dark'
                  ? 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  : theme === 'light'
                    ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    : 'bg-gray-500 hover:bg-gray-400 text-gray-300'
              }`}
            >
              <FolderOpen className="w-4 h-4" />
              Select Workspace
            </button>
            {currentPath && (
              <div className={`flex items-center gap-2 flex-1 overflow-hidden ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
                <button
                  onClick={navigateUp}
                  className={`p-1 rounded ${theme === 'dark' ? 'hover:bg-gray-700' : theme === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-500'}`}
                >
                  <ChevronDown className="w-4 h-4 rotate-[-90deg]" />
                </button>
                <span className="text-sm truncate">{currentPath}</span>
              </div>
            )}
          </div>
          
          <div className="flex-1 flex overflow-hidden editor-container">
            <div style={{ width: `${editorSplitRatio}%`, minWidth: '200px' }} className="relative flex flex-col">
              {fileContent ? (
                <Editor
                  height="100%"
                  language={currentFileLanguage}
                  theme={theme === 'dark' ? 'vs-dark' : 'light'}
                  value={fileContent}
                  onChange={(value) => setFileContent(value || '')}
                  options={{
                    minimap: { enabled: true },
                    fontSize: 14,
                    fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    wordWrap: 'on',
                    folding: true,
                    foldingHighlight: true,
                    bracketPairColorization: { enabled: true },
                    minimap: { enabled: true },
                    renderLineHighlight: 'line',
                    cursorBlinking: 'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    smoothScrolling: true,
                    fontLigatures: true,
                    contextmenu: true,
                    formatOnType: true,
                    autoClosingBrackets: 'always',
                    acceptSuggestionOnEnter: 'smart',
                    suggestOnTriggerCharacters: true,
                  }}
                  onMount={(editor) => {
                    editorRef.current = editor;
                    editor.onDidChangeCursorPosition((e) => {
                      const position = e.position;
                      setStatusBarItems(prev => ({ 
                        ...prev, 
                        line: position.lineNumber, 
                        col: position.column 
                      }));
                    });
                  }}
                />
              ) : (
                <div className={`h-full flex flex-col items-center justify-center ${theme === 'dark' ? 'bg-gray-900 text-gray-600' : theme === 'light' ? 'bg-gray-100 text-gray-400' : 'bg-gray-700 text-gray-500'}`}>
                  <Eye className="w-12 h-12 mb-4 opacity-50" />
                  <p>Select a file to view content</p>
                </div>
              )}
            </div>

            {sidebarOpen && (
              <>
                <div 
                  className={`w-1 h-full cursor-col-resize flex items-center justify-center transition-colors ${
                    isEditorDragging 
                      ? `${theme === 'dark' ? 'bg-indigo-500' : theme === 'light' ? 'bg-indigo-400' : 'bg-indigo-500'}` 
                      : `${theme === 'dark' ? 'bg-gray-600 hover:bg-gray-500' : theme === 'light' ? 'bg-gray-300 hover:bg-gray-400' : 'bg-gray-400 hover:bg-gray-300'}`
                  }`}
                  onMouseDown={() => setIsEditorDragging(true)}
                >
                  <div className={`w-0.5 h-8 rounded-full ${theme === 'dark' ? 'bg-gray-400' : theme === 'light' ? 'bg-gray-500' : 'bg-gray-300'}`} />
                </div>
                <div style={{ width: `${100 - editorSplitRatio}%`, minWidth: '150px' }} className={`border-l overflow-auto ${theme === 'dark' ? 'bg-gray-900 border-gray-700' : theme === 'light' ? 'bg-gray-100 border-gray-200' : 'bg-gray-700 border-gray-600'}`}>
                  <div className={`px-3 py-2 border-b ${theme === 'dark' ? 'border-gray-700 text-gray-400' : theme === 'light' ? 'border-gray-200 text-gray-600' : 'border-gray-600 text-gray-300'}`}>
                    <span className="text-xs font-semibold">EXPLORER</span>
                  </div>
                  <div className="py-2">
                    {renderFileTree(fileTree)}
                  </div>
                </div>
              </>
            )}
          </div>
          
          {(terminalOpen || showProblems || showOutput) && (
            <div className={`border-t ${theme === 'dark' ? 'bg-gray-900 border-gray-700' : theme === 'light' ? 'bg-gray-100 border-gray-200' : 'bg-gray-700 border-gray-600'}`} style={{ height: '200px' }}>
              <div className={`flex border-b ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-600'}`}>
                <button 
                  onClick={() => { setTerminalOpen(true); setShowProblems(false); setShowOutput(false); }}
                  className={`flex items-center gap-2 px-4 py-1.5 text-xs transition-all ${
                    terminalOpen 
                      ? `${theme === 'dark' ? 'bg-gray-800 text-white' : theme === 'light' ? 'bg-white text-gray-900' : 'bg-gray-600 text-white'}`
                      : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  Terminal
                </button>
                <button 
                  onClick={() => { setTerminalOpen(false); setShowProblems(true); setShowOutput(false); }}
                  className={`flex items-center gap-2 px-4 py-1.5 text-xs transition-all ${
                    showProblems 
                      ? `${theme === 'dark' ? 'bg-gray-800 text-white' : theme === 'light' ? 'bg-white text-gray-900' : 'bg-gray-600 text-white'}`
                      : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`
                  }`}
                >
                  <Bug className="w-3 h-3" />
                  Problems
                  {(errorCount > 0 || warningCount > 0) && (
                    <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] ${errorCount > 0 ? 'bg-red-500 text-white' : 'bg-yellow-500 text-black'}`}>
                      {errorCount > 0 ? errorCount : warningCount}
                    </span>
                  )}
                </button>
                <button 
                  onClick={() => { setTerminalOpen(false); setShowProblems(false); setShowOutput(true); }}
                  className={`flex items-center gap-2 px-4 py-1.5 text-xs transition-all ${
                    showOutput 
                      ? `${theme === 'dark' ? 'bg-gray-800 text-white' : theme === 'light' ? 'bg-white text-gray-900' : 'bg-gray-600 text-white'}`
                      : `${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`
                  }`}
                >
                  <ArrowUpDown className="w-3 h-3" />
                  Output
                </button>
                <button 
                  onClick={() => { setTerminalOpen(false); setShowProblems(false); setShowOutput(false); }}
                  className={`ml-auto p-1.5 ${theme === 'dark' ? 'text-gray-400 hover:text-white' : theme === 'light' ? 'text-gray-600 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              
              <div className="h-[calc(100%-28px)] overflow-auto">
                {terminalOpen && terminalRef.current && (
                  <div ref={terminalRef} className="h-full" />
                )}
                {showProblems && (
                  <div className="p-3 space-y-2">
                    {problems.map((problem, index) => (
                      <div key={index} className={`flex items-start gap-2 ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        {problem.type === 'error' && <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />}
                        {problem.type === 'warning' && <AlertCircle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />}
                        {problem.type === 'info' && <Clock className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />}
                        <div className="flex-1">
                          <p className="text-sm">{problem.message}</p>
                          <p className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                            {problem.file}:{problem.line}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {showOutput && (
                  <div className={`p-3 font-mono text-sm ${theme === 'dark' ? 'text-gray-300' : theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                    {outputLines.map((line, index) => (
                      <div key={index}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={`flex items-center justify-between px-3 py-1 text-xs ${theme === 'dark' ? 'bg-gray-900 text-gray-400' : theme === 'light' ? 'bg-gray-100 text-gray-600' : 'bg-gray-800 text-gray-400'}`}>
        <div className="flex items-center gap-4">
          <button className="flex items-center gap-1 hover:opacity-80 transition-opacity">
            <GitBranch className="w-3 h-3" />
            {statusBarItems.branch}
          </button>
          <span>UTF-8</span>
          <span>{statusBarItems.indentation}</span>
        </div>
        
        <div className="flex items-center gap-4">
          <span>{statusBarItems.language}</span>
          <span>Ln {statusBarItems.line}, Col {statusBarItems.col}</span>
        </div>
      </div>

      {showBrowseModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className={`rounded-xl ${theme === 'dark' ? 'bg-gray-700' : theme === 'light' ? 'bg-white' : 'bg-gray-600'}`} style={{ width: '500px', height: '400px', display: 'flex', flexDirection: 'column' }}>
            <div className={`p-4 border-b ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
              <div className={`text-lg font-medium ${theme === 'dark' ? 'text-white' : theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                Select Workspace Directory
              </div>
            </div>
            
            <div className={`px-4 py-2 border-b flex items-center gap-2 ${theme === 'dark' ? 'border-gray-600 bg-gray-800' : theme === 'light' ? 'border-gray-200 bg-gray-50' : 'border-gray-500 bg-gray-600'}`}>
              <button
                onClick={navigateUp}
                disabled={!parentPath && currentPath === ''}
                className={`p-1.5 rounded transition-all ${
                  (!parentPath && currentPath === '')
                    ? 'opacity-30 cursor-not-allowed'
                    : `${theme === 'dark' ? 'hover:bg-gray-700' : theme === 'light' ? 'hover:bg-gray-200' : 'hover:bg-gray-500'}`
                }`}
              >
                <ChevronDown className="w-5 h-5 rotate-[-90deg]" />
              </button>
              <div className={`flex-1 text-sm truncate ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
                {currentPath || 'Root'}
              </div>
            </div>
            
            <div className="flex-1 overflow-auto p-2">
              {fileTree.length === 0 ? (
                <div className={`text-center py-8 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                  Loading...
                </div>
              ) : (
                <div className="space-y-1">
                  {fileTree.map((item, index) => (
                    <div
                      key={`modal-${item.path}-${index}`}
                      onClick={() => {
                        if (item.type === 'directory' || item.type === 'drive') {
                          loadDirectory(item.path);
                        }
                      }}
                      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all ${
                        theme === 'dark'
                          ? 'hover:bg-gray-600'
                          : theme === 'light'
                            ? 'hover:bg-gray-100'
                            : 'hover:bg-gray-500'
                      }`}
                    >
                      {(item.type === 'directory' || item.type === 'drive') ? (
                        <>
                          <svg className={`w-5 h-5 flex-shrink-0 ${theme === 'dark' ? 'text-indigo-400' : theme === 'light' ? 'text-indigo-500' : 'text-indigo-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                          </svg>
                          <span className={`flex-1 text-sm truncate ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                            {item.name}
                          </span>
                          <svg className={`w-4 h-4 flex-shrink-0 ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </>
                      ) : (
                        <>
                          <svg className={`w-5 h-5 flex-shrink-0 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                          </svg>
                          <span className={`flex-1 text-sm truncate ${theme === 'dark' ? 'text-gray-200' : theme === 'light' ? 'text-gray-800' : 'text-gray-200'}`}>
                            {item.name}
                          </span>
                          <span className={`text-xs ${theme === 'dark' ? 'text-gray-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`}>
                            {item.size ? (item.size / 1024).toFixed(1) + ' KB' : ''}
                          </span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className={`flex justify-end gap-3 p-4 border-t ${theme === 'dark' ? 'border-gray-600' : theme === 'light' ? 'border-gray-200' : 'border-gray-500'}`}>
              <button
                onClick={() => setShowBrowseModal(false)}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  theme === 'dark'
                    ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                    : theme === 'light'
                      ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                      : 'bg-gray-400 hover:bg-gray-300 text-gray-300'
                }`}
              >
                Cancel
              </button>
              <button
                onClick={handleSelectWorkspace}
                disabled={!currentPath}
                className={`px-4 py-2 rounded-lg text-sm transition-all ${
                  !currentPath
                    ? 'opacity-50 cursor-not-allowed'
                    : `${theme === 'dark'
                      ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                      : theme === 'light'
                        ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`
                }`}
              >
                Select This Directory
              </button>
            </div>
          </div>
        </div>
      )}

      {commandPaletteOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50" onClick={() => setCommandPaletteOpen(false)}>
          <div 
            className={`w-[600px] rounded-lg shadow-xl ${theme === 'dark' ? 'bg-gray-800' : theme === 'light' ? 'bg-white' : 'bg-gray-700'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`flex items-center gap-3 px-4 py-3 border-b ${theme === 'dark' ? 'border-gray-700' : theme === 'light' ? 'border-gray-200' : 'border-gray-600'}`}>
              <Search className={`w-5 h-5 ${theme === 'dark' ? 'text-gray-400' : theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`} />
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="Type a command or search..."
                className={`flex-1 bg-transparent outline-none text-lg ${theme === 'dark' ? 'text-white placeholder-gray-500' : theme === 'light' ? 'text-gray-900 placeholder-gray-400' : 'text-white placeholder-gray-500'}`}
                autoFocus
              />
              <kbd className={`px-2 py-1 rounded text-xs ${theme === 'dark' ? 'bg-gray-700 text-gray-400' : theme === 'light' ? 'bg-gray-100 text-gray-600' : 'bg-gray-600 text-gray-400'}`}>ESC</kbd>
            </div>
            
            <div className="max-h-[400px] overflow-auto">
              {filteredCommands.map((cmd, index) => (
                <button
                  key={index}
                  onClick={() => { cmd.action(); setCommandPaletteOpen(false); setCommandInput(''); }}
                  className={`w-full flex items-center justify-between px-4 py-3 hover:bg-opacity-10 transition-all ${theme === 'dark' ? 'hover:bg-gray-700 text-gray-300' : theme === 'light' ? 'hover:bg-gray-100 text-gray-700' : 'hover:bg-gray-600 text-gray-300'}`}
                >
                  <div className="flex items-center gap-3">
                    <cmd.icon className="w-5 h-5" />
                    <span>{cmd.name}</span>
                  </div>
                  <kbd className={`px-2 py-1 rounded text-xs ${theme === 'dark' ? 'bg-gray-700 text-gray-500' : theme === 'light' ? 'bg-gray-100 text-gray-500' : 'bg-gray-600 text-gray-500'}`}>
                    {cmd.shortcut}
                  </kbd>
                </button>
              ))}
            </div>
            
            <div className={`px-4 py-2 border-t text-xs ${theme === 'dark' ? 'border-gray-700 text-gray-500' : theme === 'light' ? 'border-gray-200 text-gray-400' : 'border-gray-600 text-gray-500'}`}>
              Press Enter to select, Arrow keys to navigate
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CodeDevelopment;