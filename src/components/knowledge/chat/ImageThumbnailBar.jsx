import React from 'react';

export default function ImageThumbnailBar({ images, theme, removeImage }) {
  if (!images.length) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {images.map((img) => (
        <div key={img.id} className="relative group">
          <img
            src={img.url}
            alt={img.name}
            className="h-16 w-16 object-cover rounded-lg border border-gray-500 cursor-pointer"
            onClick={() => window.open(img.url, '_blank')}
            title={img.name}
          />
          <button
            onClick={() => removeImage(img.id)}
            className={`absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity ${
              theme === 'dark' ? 'bg-red-600 text-white' : 'bg-red-500 text-white'
            }`}
            title="移除图片"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
