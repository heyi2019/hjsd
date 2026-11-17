export type TestJob = [name: string, args: string[], timeout: number];
export type TestRunner = (
  name: string,
  args: string[],
  timeout: number,
  options: { buffered?: boolean },
) => Promise<void>;

export declare const runParallelJobs: (
  jobs: TestJob[],
  run: TestRunner,
) => Promise<Array<{ name: string; error: unknown }>>;
