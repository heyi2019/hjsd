import { Alert, Button } from "antd";
import { normalizeError } from "../../../../shared/api/client";

export function ReferenceDataErrors({ employeeError, poolError, retryEmployees, retryPools }: {
  employeeError: unknown;
  poolError: unknown;
  retryEmployees: () => Promise<unknown>;
  retryPools: () => Promise<unknown>;
}) {
  return <>
    {employeeError ? <Alert type="error" showIcon message={`员工目录加载失败：${normalizeError(employeeError).message}`}
      action={<Button type="link" size="small" onClick={() => { void retryEmployees().catch(() => undefined); }}>重试员工</Button>} /> : null}
    {poolError ? <Alert type="error" showIcon message={`资金账户加载失败：${normalizeError(poolError).message}`}
      action={<Button type="link" size="small" onClick={() => { void retryPools().catch(() => undefined); }}>重试资金账户</Button>} /> : null}
  </>;
}
