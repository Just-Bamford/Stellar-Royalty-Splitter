import { useState, useCallback, useMemo } from 'react';
import { StrKey } from '@stellar/stellar-sdk';

export interface Collaborator {
  id: string;
  address: string;
  percentage: number;
}

export type TemplateType = 'custom' | 'equal' | 'tiered';

export function useFormBuilder(initialCollaborators: Collaborator[] = []) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>(initialCollaborators);
  const [template, setTemplate] = useState<TemplateType>('custom');

  const addCollaborator = useCallback(() => {
    setCollaborators((prev) => [
      ...prev,
      { id: crypto.randomUUID(), address: '', percentage: 0 },
    ]);
  }, []);

  const removeCollaborator = useCallback((id: string) => {
    setCollaborators((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const updateCollaborator = useCallback((id: string, updates: Partial<Collaborator>) => {
    setCollaborators((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...updates } : c))
    );
  }, []);

  const moveCollaborator = useCallback((dragIndex: number, hoverIndex: number) => {
    setCollaborators((prev) => {
      const copy = [...prev];
      const dragged = copy[dragIndex];
      copy.splice(dragIndex, 1);
      copy.splice(hoverIndex, 0, dragged);
      return copy;
    });
  }, []);

  const applyTemplate = useCallback((type: TemplateType, founderId?: string) => {
    setTemplate(type);
    if (collaborators.length === 0) return;

    if (type === 'equal') {
      const split = 100 / collaborators.length;
      setCollaborators((prev) =>
        prev.map((c) => ({ ...c, percentage: Number(split.toFixed(2)) }))
      );
    } else if (type === 'tiered') {
      if (!founderId) founderId = collaborators[0]?.id;
      const othersCount = collaborators.length - 1;
      const othersSplit = othersCount > 0 ? 50 / othersCount : 0;
      
      setCollaborators((prev) =>
        prev.map((c) => {
          if (c.id === founderId) return { ...c, percentage: 50 };
          return { ...c, percentage: Number(othersSplit.toFixed(2)) };
        })
      );
    }
  }, [collaborators.length]);

  const importCsv = useCallback((csvText: string) => {
    try {
      const lines = csvText.split('\n').map(l => l.trim()).filter(l => l);
      const newCollabs: Collaborator[] = lines.map(line => {
        const [address, percentStr] = line.split(',').map(s => s.trim());
        const percentage = parseFloat(percentStr) || 0;
        return {
          id: crypto.randomUUID(),
          address,
          percentage
        };
      });
      setCollaborators(newCollabs);
      setTemplate('custom');
    } catch (err) {
      console.error('Failed to parse CSV', err);
    }
  }, []);

  const totalPercentage = useMemo(() => {
    return Number(collaborators.reduce((sum, c) => sum + (c.percentage || 0), 0).toFixed(2));
  }, [collaborators]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    
    if (Math.abs(totalPercentage - 100) > 0.01) {
      errors.push(`Total percentage must be 100%. Currently: ${totalPercentage}%`);
    }

    const addresses = new Set<string>();
    collaborators.forEach((c, index) => {
      if (!c.address) {
        errors.push(`Collaborator ${index + 1} is missing an address`);
      } else if (!StrKey.isValidEd25519PublicKey(c.address)) {
        errors.push(`Collaborator ${index + 1} has an invalid Stellar address`);
      } else if (addresses.has(c.address)) {
        errors.push(`Duplicate address found: ${c.address}`);
      } else {
        addresses.add(c.address);
      }
    });

    return errors;
  }, [collaborators, totalPercentage]);

  const isValid = validationErrors.length === 0;

  return {
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
    setCollaborators
  };
}
