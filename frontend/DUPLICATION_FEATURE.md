# Configuration Duplication Feature

## Overview

Users can now duplicate existing royalty split configurations to create editable drafts without modifying the original on-chain contract data. This reduces setup time for similar projects and minimizes the risk of data entry errors.

## Files Added

### Core Utilities

- **`src/utils/configDuplication.ts`** - Duplication logic and validation
  - `duplicateConfiguration()` - Creates a draft from existing collaborators
  - `isValidDuplicateConfiguration()` - Validates draft structure
  - `getDuplicateSourceDescription()` - Formats source info for UI
  - `draftToCollaborators()` - Converts draft back to form format
  - `getDuplicateBannerMessage()` - User-facing message

### UI Components

- **`src/components/DuplicateConfigBanner.tsx`** - Displays when editing a duplicate
  - Shows source configuration info
  - Displays time since duplication
  - Allows clearing duplicate flag
  - Accessible with screen reader support

- **`src/components/ConfigurationActions.tsx`** - Provides duplication action
  - Duplicate button with confirmation
  - Disabled state handling
  - Error feedback to users

### Styling

- **`src/components/DuplicateConfigBanner.css`** - Banner styling with dark mode support
- **`src/components/ConfigurationActions.css`** - Button and action styling

### Tests

- **`src/utils/__tests__/configDuplication.test.ts`** - 40+ unit tests
  - Duplication logic validation
  - Data integrity verification
  - Edge cases (empty lists, large numbers)
  - Integration workflows

- **`src/components/__tests__/DuplicateConfigBanner.test.tsx`** - Component tests
  - Rendering conditionally
  - User interactions
  - Accessibility features
  - Time formatting

- **`src/components/__tests__/ConfigurationActions.test.tsx`** - Action tests
  - Button interactions
  - Data passing
  - Error handling
  - Collaborator conversion

## Key Features

### ✅ Acceptance Criteria Met

1. **Add duplicate action to configurations**
   - `ConfigurationActions` component provides UI
   - Works with InitializeForm and other config components

2. **Copy contributor addresses and percentages**
   - Deep copy preserves all collaborator data
   - Converts numeric basisPoints to strings

3. **Allow editing before deployment**
   - Creates draft (not submitted to contract)
   - `DuplicateConfigBanner` shows draft status
   - Users can edit and modify before submitting

4. **Distinguish copy from original**
   - Banner clearly indicates "Editing a duplicate"
   - Shows source contract ID (abbreviated)
   - Shows duplication timestamp
   - "Clear" button to remove duplicate flag

5. **Prevent on-chain modification**
   - Duplication only creates local draft
   - No backend API calls during duplication
   - No contract state changes

6. **Tests for success and invalid data**
   - Tests verify duplication with valid data
   - Tests cover missing/invalid source data
   - Tests validate error handling

## Usage

### In InitializeForm

```tsx
import { ConfigurationActions } from "./ConfigurationActions";
import { DuplicateConfigBanner } from "./DuplicateConfigBanner";
import { RoyaltyConfigDraft } from "../utils/configDuplication";

function InitializeForm() {
  const [duplicate, setDuplicate] = useState<RoyaltyConfigDraft | null>(null);

  const handleDuplicate = (data) => {
    setDuplicate(
      duplicateConfiguration(data.collaborators, data.sourceContractId),
    );
    setCollaborators(data.collaborators);
  };

  return (
    <>
      {duplicate && (
        <DuplicateConfigBanner
          draft={duplicate}
          onClearDuplicate={() => setDuplicate(null)}
        />
      )}

      <ConfigurationActions
        collaborators={collaborators}
        contractId={contractId}
        onDuplicate={handleDuplicate}
        disabled={hasErrors}
      />
    </>
  );
}
```

### In CollaboratorTable

Add a duplicate action button to the table header:

```tsx
const handleDuplicateConfig = useCallback(() => {
  const draft = duplicateConfiguration(collaborators, contractId);
  onNavigateToDuplicate?.(draft); // Navigate to form with draft
}, [collaborators, contractId]);

return (
  <div className="collaborator-actions">
    <button onClick={handleDuplicateConfig}>
      📋 Duplicate This Configuration
    </button>
  </div>
);
```

## Data Flow

```
Original Configuration (on-chain)
           ↓
  User clicks "Duplicate"
           ↓
  duplicateConfiguration()
  (no API calls, local only)
           ↓
  RoyaltyConfigDraft created
           ↓
  DuplicateConfigBanner shown
           ↓
  User edits collaborators
           ↓
  User submits new config
           ↓
  New on-chain configuration
  (Original unchanged)
```

## Safety & Isolation

- **No contract modification**: Duplication is client-side only
- **Deep copy**: Original data not modified
- **Draft-only**: Changes don't persist until user submits
- **Clear indication**: Banner clearly marks as "draft"
- **Reversible**: "Clear" button removes duplicate flag anytime

## Accessibility

- Semantic HTML with proper roles
- ARIA labels on all buttons
- Screen reader support for draft status
- Status updates announced via `aria-live="polite"`
- Focus management on interactive elements

## Testing Coverage

- **Unit tests**: 40+ test cases
- **Component tests**: 15+ test cases
- **Integration tests**: Multi-step workflows
- **Edge cases**: Empty data, large datasets, errors
- **Accessibility**: ARIA attributes, screen reader support

## Performance

- **O(n) complexity**: Linear in number of collaborators
- **Shallow to deep copy**: Efficient memory usage
- **No blocking operations**: Instant local operation
- **Works with up to 50 collaborators**: Max system limit

## Browser Support

Works in all modern browsers (ES2020+):

- Chrome/Edge 91+
- Firefox 89+
- Safari 15+

## Future Enhancements

- **Naming duplicates**: Allow user-provided names for drafts
- **Template library**: Save common configurations as templates
- **Batch duplication**: Duplicate multiple configs at once
- **Comparison view**: Side-by-side comparison with original
- **Undo/redo**: Revert draft changes before submission
