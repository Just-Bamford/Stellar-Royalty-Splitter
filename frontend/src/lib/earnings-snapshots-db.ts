import type { DailySnapshot } from "./earnings-history";

const DB_NAME = "srs-earnings-history";
const DB_VERSION = 1;
const STORE = "snapshots";

type SnapshotRow = DailySnapshot & {
  key: string;
  walletAddress: string;
  syncedAt: string;
};

function snapshotKey(walletAddress: string, date: string, contractId: string) {
  return `${walletAddress}|${date}|${contractId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this environment"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("by-wallet", "walletAddress", { unique: false });
        store.createIndex("by-wallet-date", ["walletAddress", "date"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function readCachedSnapshots(walletAddress: string): Promise<DailySnapshot[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("by-wallet");
    const rows = await requestToPromise(index.getAll(walletAddress));
    db.close();
    return (rows as SnapshotRow[]).map(({ date, contractId, amount }) => ({
      date,
      contractId,
      amount,
    }));
  } catch {
    return [];
  }
}

export async function writeSnapshots(
  walletAddress: string,
  snapshots: DailySnapshot[],
): Promise<void> {
  try {
    const db = await openDb();
    const syncedAt = new Date().toISOString();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    await Promise.all(
      snapshots.map((snapshot) =>
        requestToPromise(
          store.put({
            key: snapshotKey(walletAddress, snapshot.date, snapshot.contractId),
            walletAddress,
            syncedAt,
            ...snapshot,
          }),
        ),
      ),
    );

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
    db.close();
  } catch {
    // Offline/local cache is best-effort.
  }
}

export async function mergeSnapshots(
  walletAddress: string,
  incoming: DailySnapshot[],
): Promise<DailySnapshot[]> {
  const existing = await readCachedSnapshots(walletAddress);
  const merged = new Map<string, DailySnapshot>();

  for (const row of [...existing, ...incoming]) {
    merged.set(`${row.date}|${row.contractId}`, row);
  }

  const result = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
  await writeSnapshots(walletAddress, result);
  return result;
}

export async function clearWalletSnapshots(walletAddress: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const index = tx.objectStore(STORE).index("by-wallet");
    const rows = (await requestToPromise(index.getAll(walletAddress))) as SnapshotRow[];
    await Promise.all(rows.map((row) => requestToPromise(tx.objectStore(STORE).delete(row.key))));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB clear failed"));
    });
    db.close();
  } catch {
    // Best-effort cleanup.
  }
}
