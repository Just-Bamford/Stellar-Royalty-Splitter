const documents = new Map();

function getDocument(contractId) {
  if (!documents.has(contractId)) {
    documents.set(contractId, { contractId, revision: 0, settings: {}, history: [] });
  }
  return documents.get(contractId);
}

function applyOperation(settings, operation) {
  if (!operation || operation.type !== "set") throw new Error("Only set operations are supported");
  if (typeof operation.path !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(operation.path)) {
    throw new Error("Invalid collaboration field");
  }
  const next = { ...settings };
  next[operation.path] = operation.value;
  return next;
}

export function readDocument(contractId) {
  const document = getDocument(contractId);
  return { contractId, revision: document.revision, settings: { ...document.settings } };
}

export function applyOperationToDocument(contractId, operation, actor, baseRevision) {
  const document = getDocument(contractId);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new Error("baseRevision is required");
  if (baseRevision > document.revision) throw new Error("baseRevision is ahead of the server revision");

  // Settings are independent scalar fields, so rebasing an older operation is
  // deterministic: apply it to the current document and record the conflict.
  const rebased = baseRevision !== document.revision;
  const settings = applyOperation(document.settings, operation);
  document.revision += 1;
  const change = {
    revision: document.revision,
    actor,
    operation,
    rebased,
    timestamp: new Date().toISOString(),
  };
  document.settings = settings;
  document.history.push(change);
  if (document.history.length > 100) document.history.shift();
  return { ...readDocument(contractId), change };
}

export function listCollaborators(contractId) {
  const document = getDocument(contractId);
  return [...new Set(document.history.map((change) => change.actor).filter(Boolean))];
}
