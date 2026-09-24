let activeOperation: Promise<void> = Promise.resolve();

/** 将插件内所有仓库操作串行化，避免计时器与命令同时改动工作树。 */
export async function withSyncLock<T>(operation: () => Promise<T>): Promise<T> {
  const previousOperation = activeOperation;
  let release!: () => void;
  activeOperation = new Promise<void>((resolve) => { release = resolve; });
  await previousOperation;
  try {
    return await operation();
  } finally {
    release();
  }
}
