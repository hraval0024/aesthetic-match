// Persists the user's uploaded reference photos (real File blobs) across
// client-side navigation -- e.g. /profile -> /recommendations -> back to
// /profile to edit. sessionStorage is string-only and our images can total
// tens of MB, so IndexedDB (which stores Blobs natively) is the correct
// tool here, not a size hack. Single overwritable working set, cleared
// explicitly on "start over" -- this isn't a multi-draft history feature.

const DB_NAME = "aesthetic-match";
const STORE_NAME = "profile-images";
const DB_VERSION = 1;

export type StoredImage = { clientId: string; file: File };

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: "clientId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveImages(images: StoredImage[]): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const img of images) store.put(img);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadImages(): Promise<StoredImage[]> {
  const db = await openDB();
  try {
    return await new Promise<StoredImage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as StoredImage[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function clearImages(): Promise<void> {
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
