import type { LocalContributionJob } from "./browser-types";

const DATABASE_NAME = "transcript-registry-local-jobs";
const DATABASE_VERSION = 1;
const JOB_STORE = "jobs";
const MEDIA_DIRECTORY = "transcript-registry-local-jobs";

export async function listLocalJobs(): Promise<LocalContributionJob[]> {
  return request<LocalContributionJob[]>(
    (store) => store.getAll(),
    "readonly",
  ).then((jobs) =>
    jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

export async function saveLocalJob(
  job: LocalContributionJob,
): Promise<void> {
  await request<IDBValidKey>((store) => store.put(job), "readwrite");
}

export async function deleteLocalJob(jobId: string): Promise<void> {
  await request<undefined>((store) => store.delete(jobId), "readwrite");
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(MEDIA_DIRECTORY, { create: true });
  await jobs.removeEntry(jobId, { recursive: true }).catch(() => undefined);
}

export async function persistMedia(
  jobId: string,
  file: File,
): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    throw new Error(
      "This browser does not support private local file storage (OPFS).",
    );
  }
  void navigator.storage.persist?.();
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(MEDIA_DIRECTORY, { create: true });
  const directory = await jobs.getDirectoryHandle(jobId, { create: true });
  const handle = await directory.getFileHandle("source", { create: true });
  const writable = await handle.createWritable();
  try {
    await file.stream().pipeTo(writable);
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

export async function loadPersistedMedia(
  job: LocalContributionJob,
): Promise<File> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("Private local file storage is unavailable.");
  }
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(MEDIA_DIRECTORY);
  const directory = await jobs.getDirectoryHandle(job.jobId);
  const handle = await directory.getFileHandle("source");
  const blob = await handle.getFile();
  return new File([blob], job.fileName, {
    type: job.fileType,
    lastModified: blob.lastModified,
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(JOB_STORE)) {
        open.result.createObjectStore(JOB_STORE, { keyPath: "jobId" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function request<T>(
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  mode: IDBTransactionMode,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(JOB_STORE, mode);
      const result = operation(transaction.objectStore(JOB_STORE));
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
