// Manual mock for better-sqlite3 — prevents native binary load during tests.
// Uses plain stubs; jest.fn() is not available in ESM manual mocks.
const noop = () => {};
const mockDb = {
  pragma: noop,
  prepare: () => ({ run: noop, get: noop, all: () => [] }),
  exec: noop,
  transaction: (fn) => fn,
};

export default function Database() {
  return mockDb;
}
