import React, { useRef } from 'react';
import { Collaborator } from '../hooks/useFormBuilder';
import '../styles/design-tokens.css';

interface CollaboratorBuilderProps {
  collaborator: Collaborator;
  index: number;
  updateCollaborator: (id: string, updates: Partial<Collaborator>) => void;
  removeCollaborator: (id: string) => void;
  moveCollaborator: (dragIndex: number, hoverIndex: number) => void;
}

export const CollaboratorBuilder: React.FC<CollaboratorBuilderProps> = ({
  collaborator,
  index,
  updateCollaborator,
  removeCollaborator,
  moveCollaborator,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dragIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (dragIndex === index) return;
    moveCollaborator(dragIndex, index);
  };

  return (
    <div
      ref={ref}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-md)',
        padding: 'var(--spacing-md)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 'var(--spacing-sm)',
        cursor: 'grab',
      }}
    >
      <div style={{ color: 'var(--text-tertiary)' }}>
        {/* Drag handle icon */}
        ☰
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 'var(--spacing-sm)' }}>
        <input
          type="text"
          className="input"
          placeholder="Stellar Address (G...)"
          value={collaborator.address}
          onChange={(e) => updateCollaborator(collaborator.id, { address: e.target.value })}
          style={{ flex: 1, background: 'var(--bg-primary)' }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', width: '200px' }}>
          <input
            type="range"
            min="0"
            max="100"
            step="0.01"
            value={collaborator.percentage}
            onChange={(e) => updateCollaborator(collaborator.id, { percentage: parseFloat(e.target.value) || 0 })}
            style={{ flex: 1 }}
          />
          <span style={{ width: '60px', textAlign: 'right' }}>
            {collaborator.percentage}%
          </span>
        </div>
      </div>

      <button
        onClick={() => removeCollaborator(collaborator.id)}
        style={{
          background: 'var(--error-light)',
          color: 'var(--error-dark)',
          border: 'none',
          padding: 'var(--spacing-sm)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}
        title="Remove Collaborator"
      >
        ✕
      </button>
    </div>
  );
};
