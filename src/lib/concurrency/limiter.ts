// Keeps exactly `concurrency` calls in flight at all times (unlike chunking
// into Promise.all batches, which stalls each batch on its slowest item).
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}
