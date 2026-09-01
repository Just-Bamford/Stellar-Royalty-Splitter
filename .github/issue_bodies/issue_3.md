Backend API documentation exists in `API.md` but is maintained manually and not structured in a machine-readable format. Developers must manually search `API.md` to understand endpoints, parameters, error codes, and request/response schemas. An OpenAPI specification would enable:
- Auto-generated interactive API documentation (Swagger UI)
- Client SDK generation
- Integration testing tools
- Consistency checks between documentation and implementation

**Relevant files:**
- `backend/API.md` - manual documentation
- `backend/src/swagger.js` - exists but may be incomplete or out of sync

## Solution

Create a complete OpenAPI 3.0 specification covering all v1 routes. Wire it into the Express backend to serve Swagger UI at `/api/v1/docs`. The spec should include request/response examples, error codes, and authentication requirements. Add tooling to detect drift between the spec and actual route implementations.

## Acceptance Criteria

- [ ] OpenAPI spec (YAML or JSON) covers all endpoints in `backend/src/routes/`
- [ ] Swagger UI is served at `/api/v1/docs` and renders without errors
- [ ] Spec includes example requests and responses for each endpoint
- [ ] Error response schemas match the structure defined in `backend/src/error-response.js`
- [ ] All error codes documented in `API.md` are present in the OpenAPI spec
- [ ] README links to the Swagger UI endpoint
- [ ] Existing backend tests continue to pass

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.

Do not expose internal implementation details, database schemas, or sensitive configuration in the OpenAPI spec. Focus on the public contract: endpoints, parameters, and error responses.
