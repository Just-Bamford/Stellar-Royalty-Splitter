Both backend and frontend validate Stellar addresses (G...) independently using different approaches. Backend uses Zod schemas in `backend/src/validation.js`, while frontend has scattered regex or SDK-based checks. Inconsistencies between layers can allow invalid addresses to be accepted upstream. No single source of truth for address format or checksum validation.

**Relevant files:**
- `backend/src/validation.js` - address validation
- `frontend/src/utils/` - likely scattered validation
- `frontend/src/components/WalletConnect.tsx` - wallet validation

## Solution

Extract address validation into a shared utility module or package. Ensure both backend (Zod) and frontend (TypeScript type guards) use the same validation rules. Test the utility against known valid/invalid Stellar addresses and verify it matches Stellar SDK behavior.

## Acceptance Criteria

- [ ] Create a shared validation utility for Stellar G... addresses
- [ ] Utility exports both a Zod schema (for backend) and a type guard (for frontend)
- [ ] Test against Stellar SDK's address validation
- [ ] Update backend validation to use the shared utility
- [ ] Update frontend components to use the shared utility
- [ ] Add tests for edge cases: checksums, length, character sets

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.
