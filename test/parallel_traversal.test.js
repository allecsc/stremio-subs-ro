const assert = require("assert");

/**
 * Concurrency helper: processes an array of items with a maximum concurrency limit.
 */
async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);

    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }

  const settled = await Promise.allSettled(results);
  return settled
    .filter((res) => res.status === "fulfilled")
    .map((res) => res.value);
}

async function runTests() {
  console.log("=== Running Parallel Archive Traversal Tests ===");

  // 1. Parallel batching test
  console.log("Test 1: Parallel concurrency batching (4 workers)");
  const mockArchives = [1, 2, 3, 4, 5, 6, 7, 8];
  let activeWorkers = 0;
  let maxObservedWorkers = 0;

  const start = Date.now();
  const results = await mapConcurrent(mockArchives, 4, async (id) => {
    activeWorkers++;
    maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
    await new Promise((r) => setTimeout(r, 50));
    activeWorkers--;
    return `archive_${id}`;
  });
  const duration = Date.now() - start;

  assert.strictEqual(results.length, 8);
  assert(maxObservedWorkers <= 4, `Max workers was ${maxObservedWorkers}, must be <= 4`);
  assert(duration < 250, `8 items with 50ms sleep in batches of 4 took ${duration}ms, must be < 250ms`);
  console.log(`✓ Passed: 8 archives processed concurrently in ${duration}ms (Max concurrency: ${maxObservedWorkers})`);

  // 2. Resilience test: 1 failure does not crash the batch
  console.log("Test 2: Failure resilience (1 corrupt archive)");
  const resultsWithFailure = await mapConcurrent([1, 2, 3, 4], 4, async (id) => {
    if (id === 3) throw new Error("Corrupt RAR");
    return `valid_${id}`;
  });

  assert.deepStrictEqual(resultsWithFailure, ["valid_1", "valid_2", "valid_4"]);
  console.log("✓ Passed: Corrupt archive caught gracefully without failing the search");

  console.log("\nALL PARALLEL TRAVERSAL TESTS PASSED ✓");
}

runTests();
