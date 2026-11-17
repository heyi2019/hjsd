/** 在不改变失败收集语义的前提下并行执行彼此独立的测试层。 */
export const runParallelJobs = async (jobs, run) => {
  const results = await Promise.allSettled(
    jobs.map(([name, args, timeout]) => run(name, args, timeout, { buffered: true })),
  );

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    return [{ name: jobs[index][0], error: result.reason }];
  });
};
