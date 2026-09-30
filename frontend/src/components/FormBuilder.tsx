import React, { useRef } from 'react';
import { useFormBuilder } from '../hooks/useFormBuilder';
import { CollaboratorBuilder } from './CollaboratorBuilder';

export const FormBuilder: React.FC = () => {
  const {
    collaborators,
    template,
    totalPercentage,
    validationErrors,
    isValid,
    addCollaborator,
    removeCollaborator,
    updateCollaborator,
    moveCollaborator,
    applyTemplate,
    importCsv,
  } = useFormBuilder();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) importCsv(text);
    };
    reader.readAsText(file);
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="card" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'var(--font-weight-bold)', marginBottom: 'var(--spacing-lg)' }}>
        Royalty Split Setup
      </h2>

      <div style={{ marginBottom: 'var(--spacing-lg)' }}>
        <h3 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--spacing-sm)' }}>Templates</h3>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
          <button
            className={`btn ${template === 'equal' ? 'btn-primary' : ''}`}
            onClick={() => applyTemplate('equal')}
            style={{
              padding: 'var(--spacing-sm) var(--spacing-md)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-primary)',
              background: template === 'equal' ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-dark))' : 'var(--bg-secondary)',
              color: template === 'equal' ? 'var(--text-inverse)' : 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Equal Split
          </button>
          <button
            className={`btn ${template === 'tiered' ? 'btn-primary' : ''}`}
            onClick={() => applyTemplate('tiered')}
            style={{
              padding: 'var(--spacing-sm) var(--spacing-md)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-primary)',
              background: template === 'tiered' ? 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-dark))' : 'var(--bg-secondary)',
              color: template === 'tiered' ? 'var(--text-inverse)' : 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Tiered (50% Founder)
          </button>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: 'var(--spacing-sm) var(--spacing-md)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                cursor: 'pointer'
              }}
            >
              Import CSV
            </button>
            <input
              type="file"
              accept=".csv"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 'var(--spacing-lg)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-sm)' }}>
          <h3 style={{ fontSize: 'var(--font-size-lg)' }}>Collaborators</h3>
          <button
            onClick={addCollaborator}
            style={{
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)',
              cursor: 'pointer'
            }}
          >
            + Add
          </button>
        </div>
        
        {collaborators.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
            No collaborators added yet. Click "+ Add" or import a CSV.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {collaborators.map((collaborator, index) => (
              <CollaboratorBuilder
                key={collaborator.id}
                index={index}
                collaborator={collaborator}
                updateCollaborator={updateCollaborator}
                removeCollaborator={removeCollaborator}
                moveCollaborator={moveCollaborator}
              />
            ))}
          </div>
        )}
      </div>

      <div style={{ 
        padding: 'var(--spacing-md)', 
        background: 'var(--bg-secondary)', 
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        border: Math.abs(totalPercentage - 100) > 0.01 ? '1px solid var(--error)' : '1px solid var(--success)'
      }}>
        <span style={{ fontWeight: 'var(--font-weight-semibold)' }}>Total Allocation:</span>
        <span style={{ 
          fontSize: 'var(--font-size-xl)', 
          fontWeight: 'var(--font-weight-bold)',
          color: Math.abs(totalPercentage - 100) > 0.01 ? 'var(--error)' : 'var(--success)'
        }}>
          {totalPercentage}%
        </span>
      </div>

      {!isValid && (
        <div style={{ 
          marginTop: 'var(--spacing-md)', 
          padding: 'var(--spacing-md)', 
          background: 'var(--error-light)', 
          color: 'var(--error-dark)',
          borderRadius: 'var(--radius-md)'
        }}>
          <ul style={{ margin: 0, paddingLeft: 'var(--spacing-lg)' }}>
            {validationErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
      
      <div style={{ marginTop: 'var(--spacing-lg)', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn-primary"
          disabled={!isValid || collaborators.length === 0}
          style={{
            opacity: (!isValid || collaborators.length === 0) ? 0.5 : 1,
            cursor: (!isValid || collaborators.length === 0) ? 'not-allowed' : 'pointer',
            background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-dark))',
            color: 'var(--text-inverse)',
            padding: 'var(--spacing-sm) var(--spacing-lg)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 'var(--font-weight-semibold)',
            border: 'none'
          }}
        >
          Save Template
        </button>
      </div>
    </div>
  );
};
