/** ImportWorkbench 的共享常量与纯函数（拆分自导入工作台主组件）。 */
/** 嵌入模式：作为「设置」页内的 Tab 渲染时，不再重复输出 PageHeader 大标题，
 *  红线说明降级为次要文本，批次选择与确认/回滚动作保留为筛选条。 */
export const RED_LINE_DESC = "导入数据只保留原文与人工映射：不覆盖新单、不自动匹配、不补造单边划转。";

export function parseImportText(text: string, filename: string): Record<string, unknown>[] {
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("JSON 文件必须是对象数组");
    }
    return parsed as Record<string, unknown>[];
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV 文件至少需要一行表头和一行数据");
  const headers = lines[0].split(",").map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });
}

export const IMPORT_TEMPLATES: Record<string, { filename: string; content: string }> = {
  STANDARD_ORDER: {
    filename: "订单导入模板.csv",
    content: "订单日期,订单类型,订单金额,本金,利润,经办人,备注\n2026-01-31,HS,0.00,0.00,0.00,,",
  },
  STANDARD_ACCOUNT: {
    filename: "账号导入模板.csv",
    content: "库存编号,平台,区服,状态,买入日期,买入成本,预计售价,备注\n,, ,IN_STOCK,2026-01-31,0.00,0.00,",
  },
  STANDARD_CASHFLOW: {
    filename: "资金流水导入模板.csv",
    content: "发生日期,金额,收支方向,资金池,业务类型,订单号,说明\n2026-01-31,0.00,IN,,HS,,",
  },
  STANDARD_INSTALLMENT: {
    filename: "分期导入模板.csv",
    content: "合同日期,合同类型,本金,首付,期数,每期金额,已收金额,状态,备注\n2026-01-31,STOCK_SALE,0.00,0.00,1,0.00,0.00,PENDING,",
  },
  STANDARD_LEAD: {
    filename: "需求导入模板.csv",
    content: "客户ID,需求类型,预算,需求内容,负责人ID,备注\n1,FIND_ACCOUNT,0.00,求购指定账号,,",
  },
};

export function downloadImportTemplate(sourceKind: string) {
  const template = IMPORT_TEMPLATES[sourceKind] ?? IMPORT_TEMPLATES.STANDARD_ORDER;
  const blob = new Blob([`\uFEFF${template.content}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = template.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type ImportWorkbenchProps = {
  embedded?: boolean;
  /** 受控批次选择：由父级（如 SettingsPage）持有，避免 Tab 非挂载时丢失筛选。 */
  batchId?: number | null;
  onBatchIdChange?: (id: number | null) => void;
};
